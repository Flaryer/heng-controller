import { Logger } from "@nestjs/common";
import {
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
    WebSocketGateway
} from "@nestjs/websockets";
import { RedisService } from "src/redis/redis.service";
import WebSocket from "ws";
import { IncomingMessage } from "http";
import { URL } from "url";
import { JudgerConfig } from "src/config/judger.config";
import { ConfigService } from "src/config/config-module/config.service";
import {
    SendMessageQueueSuf,
    JudgerLogSuf,
    AllReport,
    LifePing,
    AllToken,
    Token,
    CallRecordItem,
    SendMessageQueueItem,
    WsResRecordItem,
    ResQueueSuf,
    UnusedToken,
    OnlineToken,
    DisabledToken,
    ClosedToken,
    ProcessOwnWsSuf,
    ProcessLife
} from "./judger.decl";
import { JudgerService } from "./judger.service";
import {
    ControlArgs,
    ExitArgs,
    JudgeArgs,
    JudgerArgs,
    JudgerMethod,
    Request,
    Response,
    ControllerMethod,
    ControllerArgs,
    LogArgs,
    ReportStatusArgs,
    UpdateJudgesArgs,
    FinishJudgesArgs
} from "./dto/ws";
import moment from "moment";
import * as crypto from "crypto";
import { ErrorInfo } from "./dto/http";
import { setInterval } from "timers";

@WebSocketGateway(undefined, {
    // 此处 path 不生效！检测 path 加在 handleConnection 里面了
    path: "/judger"
})
export class JudgerGateway
    implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
    private readonly logger = new Logger("Gateway");
    private readonly judgerConfig: JudgerConfig;
    private readonly callRecord = new Map<number, CallRecordItem>();
    private readonly wsRepRecord = new Map<string, WsResRecordItem>();
    private readonly methods = new Map<
        ControllerMethod,
        (ws: WebSocket, wsId: string, args: any) => Promise<unknown>
    >();
    private readonly ownTasks = new Map<string, Set<string>>();

    private callSeq = 0;

    constructor(
        private readonly redisService: RedisService,
        private readonly configService: ConfigService,
        private readonly judgerService: JudgerService
    ) {
        this.judgerConfig = this.configService.getConfig().judger;

        this.methods.set(
            "Log",
            async (
                ws: WebSocket,
                wsId: string,
                { level, code, message }: LogArgs
            ) => {
                await this.log(
                    wsId,
                    `level:${level}，code: ${code}，message: ${message}`
                );
            }
        );

        this.methods.set(
            "Exit",
            async (
                ws: WebSocket,
                wsId: string,
                { reboot, rebootDelay, reason }: ExitArgs
            ) => {
                await this.removeJudger(wsId);
                await this.log(
                    wsId,
                    `主动请求退出，reboot：${reboot}，rebootDelay：${rebootDelay ??
                        "无"}，reason：${reason ?? "无"}`
                );
            }
        );

        this.methods.set(
            "ReportStatus",
            async (ws: WebSocket, wsId: string, args: ReportStatusArgs) => {
                await this.redisService.client
                    .multi()
                    .hset(AllReport, wsId, JSON.stringify(args))
                    .hset(LifePing, wsId, Date.now())
                    .exec();
            }
        );

        this.methods.set(
            "UpdateJudges",
            async (ws: WebSocket, wsId: string, args: UpdateJudgesArgs) => {
                const allTask = this.ownTasks.get(wsId);
                if (!allTask) throw new Error("评测机失效");
                const vaildResult = args.filter(async ({ id }) => {
                    return allTask.has(id);
                });
                // TODO 通知外部系统
            }
        );

        this.methods.set(
            "FinishJudges",
            async (ws: WebSocket, wsId: string, args: FinishJudgesArgs) => {
                const allTask = this.ownTasks.get(wsId);
                if (!allTask) throw new Error("评测机失效");
                const vaildResult = args.filter(({ id }) => allTask.has(id));
                // TODO 通知外部系统
                for (const { id } of vaildResult) {
                    allTask.delete(id);
                }
                await this.releaseJudger(
                    wsId,
                    vaildResult.map(({ id }) => id)
                );
            }
        );

        setInterval(async () => {
            await this.redisService.client.hset(
                ProcessLife,
                String(process.pid),
                Date.now()
            );
        }, this.judgerConfig.processPingInterval);

        // 本进程监听 res 队列
        setTimeout(async () => {
            while (true) {
                try {
                    await this.redisService.withClient(async client => {
                        const resTuple = await client.brpop(
                            process.pid + ResQueueSuf,
                            this.judgerConfig.listenTimeoutSec
                        );
                        if (!resTuple) return;
                        const res: Response = JSON.parse(resTuple[1]);
                        const record = this.callRecord.get(res.seq);
                        if (!record) throw new Error("callRecord 记录丢失");
                        record.cb(res.body);
                    });
                } catch (error) {
                    this.logger.error(error.message);
                }
            }
        }, 0);

        // 心跳检测
        setTimeout(() => {
            setInterval(async () => {
                const ret = await this.redisService.client.hgetall(LifePing);
                for (const token in ret) {
                    if (
                        Date.now() - parseInt(ret[token]) >
                        this.judgerConfig.reportInterval
                    ) {
                        await this.forceDisconnect(token, "长时间未发生心跳");
                    }
                }
            }, this.judgerConfig.lifeCheckInterval);
        }, Math.random() * this.judgerConfig.lifeCheckInterval);

        // Token GC
        setTimeout(() => {
            setInterval(async () => {
                const ret = await this.redisService.client.hgetall(ClosedToken);
                for (const token in ret) {
                    if (
                        Date.now() - parseInt(ret[token]) >
                        this.judgerConfig.tokenGcExpire
                    ) {
                        await this.cleanToken(token);
                    }
                }
            }, this.judgerConfig.tokenGcInterval);
        }, Math.random() * this.judgerConfig.tokenGcInterval);

        // 其他进程存活检测
        setTimeout(() => {
            setInterval(async () => {
                const ret = await this.redisService.client.hgetall(ProcessLife);
                for (const pid in ret) {
                    if (
                        Date.now() - parseInt(ret[pid]) >
                        this.judgerConfig.processPingInterval
                    ) {
                        const tokens = await this.redisService.client.smembers(
                            pid + ProcessOwnWsSuf
                        );
                        let mu = this.redisService.client.multi();
                        for (const token of tokens) {
                            await this.removeJudger(token);
                            mu = mu
                                .hdel(OnlineToken, token)
                                .hdel(DisabledToken, token)
                                .hset(ClosedToken, token, Date.now())
                                .hdel(LifePing, token);
                        }
                        mu.del(pid + ProcessOwnWsSuf)
                            .hdel(ProcessLife, pid)
                            .del(pid + ResQueueSuf);
                        await mu.exec();
                    }
                }
            }, this.judgerConfig.processCheckInterval);
        }, Math.random() * this.judgerConfig.processPingInterval);
    }

    async afterInit(server: WebSocket.Server): Promise<void> {
        this.logger.log("WebSocket 网关已启动");
    }

    async handleConnection(
        client: WebSocket,
        req: IncomingMessage
    ): Promise<void> {
        // 检查 path 和 token 合法性
        const ip = String(req.headers["x-forwarded-for"] ?? "unknown").split(
            ","
        )[0];
        const token: string =
            new URL("http://example.com" + req.url ?? "").searchParams.get(
                "token"
            ) ?? "";
        if (
            !req.url ||
            !req.url.startsWith(this.judgerConfig.webSocketPath) ||
            !(await this.checkToken(token, ip))
        ) {
            client.close();
            client.terminate();
            return;
        }

        // 评测机上线后处理
        try {
            await this.redisService.client
                .multi()
                .hdel(UnusedToken, token)
                .hset(OnlineToken, token, Date.now())
                .hset(LifePing, token, Date.now())
                .sadd(process.pid + ProcessOwnWsSuf, token)
                .exec();

            client.on("message", await this.getSolveMessage(client, token));
            client.on("close", await this.getSolveClose(client, token));
            client.on("error", await this.getSolveError(client, token));

            this.listenMessageQueue(client, token);
            await this.log(token, "上线");
        } catch (error) {
            await this.log(token, error.message);
            client.close();
            client.terminate();
        }
        await this.callControl(token, {
            statusReportInterval: this.judgerConfig.reportInterval
        });
    }

    // 目前未使用
    handleDisconnect(client: WebSocket): void {
        // this.logger.warn("out");
    }

    //------------------------ws/评测机连接 [可调用]-------------------------------
    /**
     * 发送 JudgeRequestMessage 到 redis 消息队列
     * @param wsId
     * @param taskId
     * @param transId
     */
    async callJudge(wsId: string, taskId: string): Promise<void> {
        const judgeInfo: JudgeArgs = await this.getJudgeRequestInfo(taskId);
        await this.call(wsId, {
            method: "Judge",
            args: judgeInfo
        });
    }

    /**
     * 发送控制消息
     * @param wsId
     * @param reportInterval
     */
    async callControl(wsId: string, args: ControlArgs): Promise<void> {
        await this.call(wsId, {
            method: "Control",
            args: args
        });
    }

    /**
     * 要求评测机下线
     * @param wsId
     * @param args
     */
    async callExit(wsId: string, args: ExitArgs): Promise<void> {
        await this.call(wsId, {
            method: "Exit",
            args: args
        });
        await this.removeJudger(wsId);
        const e = `控制端请求评测机关机，原因：${args.reason ?? "无"}`;
        await this.log(wsId, e);
    }

    /**
     * 控制端主动与评测机断连
     * 发生 close 请求到 redis 消息队列
     * @param wsId
     * @param code
     * @param reason
     * @param expectedRecoveryTime
     */
    async forceDisconnect(wsId: string, reason: string): Promise<void> {
        await this.removeJudger(wsId);
        const msg: SendMessageQueueItem = {
            pid: process.pid,
            closeReason: reason
            // req : undefined
        } as SendMessageQueueItem;
        await this.redisService.client.lpush(
            wsId + SendMessageQueueSuf,
            JSON.stringify(msg)
        );
        const e = `控制端请求断开连接，原因：${reason}`;
        await this.log(wsId, e);
    }

    //---------------------------外部交互[请填充]--------------------------
    /**
     * 外部交互 please fill this
     * 获取 redis 中某任务的详细信息
     * @param taskId
     */
    private async getJudgeRequestInfo(taskId: string): Promise<JudgeArgs> {
        // FIXME
        // const infoStr = await this.redisService.client.hget(
        //     // FIXME
        //     "key_judgeInfo",
        //     taskId
        // );
        // if (!infoStr) throw new Error(`taskId:${taskId} 找不到 JudgeInfo`);
        // const info: JudgeArgs = JSON.parse(infoStr);
        // return info;
        return {} as JudgeArgs;
    }

    //---------------------------与评测机池交互[请填充]----------------------
    async distributTask(wsId: string, taskId: string): Promise<void> {
        if (!(await this.redisService.client.hexists(OnlineToken, wsId))) {
            throw new Error("Judger 不可用");
        }
        await this.callJudge(wsId, taskId);
        let allTask = this.ownTasks.get(wsId);
        if (!allTask) {
            allTask = new Set<string>();
            allTask.add(taskId);
            this.ownTasks.set(wsId, allTask);
        } else allTask.add(taskId);
    }

    /**
     * 通知评测机池移除评测机
     * 评测机池 please fill this
     * @param wsId
     */
    private async removeJudger(wsId: string): Promise<void> {
        // 以下顺序不可调换
        await this.log(wsId, "已请求评测机池移除此评测机");
        await this.redisService.client
            .multi()
            .hdel(OnlineToken, wsId)
            .hset(DisabledToken, wsId, Date.now())
            .exec();
        // await this.poolService.removeJudger(wsId);
    }

    /**
     * 通知评测机池添加评测机
     * 评测机池 please fill this
     * @param wsId
     */
    private async addJudger(wsId: string): Promise<void> {
        await this.log(wsId, "已请求评测机池添加此评测机");
        const infoStr = await this.redisService.client.hget(AllToken, wsId);
        if (!infoStr) throw new Error("token 记录丢失");
        const judgerInfo: Token = JSON.parse(infoStr);
        // await this.poolService.addJudger(wsId, judgerInfo.maxTaskCount);
        // await this.transService.AddEmptyTrans(wsId);
    }

    /**
     * 一次评测结束后通知评测机池释放算力
     * 评测机池 please fill this
     * @param wsId
     */
    private async releaseJudger(wsId: string, taskId: string[]): Promise<void> {
        this.logger.debug(
            `已请求评测机池释放评测机 ${wsId.split(".")[0]} 的算力`
        );
        //......
    }

    //---------------------------token------------------------------------
    async getToken(
        maxTaskCount: number,
        coreCount: number,
        name: string,
        software: string,
        ip: string
    ): Promise<string> {
        const token =
            name +
            "." +
            crypto
                .createHmac("sha256", String(Date.now()))
                .update(maxTaskCount + coreCount + name + software + ip)
                .digest("hex");
        const e = `ip: ${ip}, name: ${name} 获取了 token`;
        await this.redisService.client
            .multi()
            .hset(
                AllToken,
                token,
                JSON.stringify({
                    maxTaskCount,
                    coreCount,
                    name,
                    software,
                    ip,
                    createTime: moment().format("YYYY-MM-DDTHH:mm:ssZ")
                } as Token)
            )
            .hset(UnusedToken, token, Date.now())
            .exec();
        await this.log(token, e);
        return token;
    }

    async checkToken(token: string, ip: string): Promise<boolean> {
        if (!(await this.redisService.client.hexists(UnusedToken, token))) {
            this.logger.warn(`token ${token} 不存在或已使用`);
            return false;
        } // 检测 token 未使用
        const tokenInfo = JSON.parse(
            (await this.redisService.client.hget(AllToken, token)) ?? ""
        ) as Token;
        if (tokenInfo.ip !== ip) {
            this.logger.warn(`token ${token} 被盗用`);
            return false;
        } // 检测 ip 是否相同
        if (
            Date.parse(tokenInfo.createTime) + this.judgerConfig.tokenExpire <
            Date.now()
        ) {
            this.logger.warn(`token ${token} 已过期`);
            return false;
        } // 检测 token 有效期
        return true;
    }

    //----------------------------WebSocket 基础部分[不可外部调用]------------------
    /**
     * 监听消息队列
     * @param ws
     * @param wsId
     */
    async listenMessageQueue(ws: WebSocket, wsId: string): Promise<void> {
        let wsSeq = 0;
        while (ws && ws.readyState <= WebSocket.OPEN) {
            try {
                await this.redisService.withClient(async client => {
                    const msgTuple = await client.brpop(
                        wsId + SendMessageQueueSuf,
                        this.judgerConfig.listenTimeoutSec
                    );
                    if (!msgTuple) return;
                    const msg: SendMessageQueueItem = JSON.parse(msgTuple[1]);
                    if (msg.closeReason) {
                        ws.close(1000, msg.closeReason);
                        return;
                    }
                    const seq = (wsSeq = wsSeq + 1);
                    this.wsRepRecord.set(wsId + seq, {
                        pid: msg.pid,
                        seq: msg.req.seq
                    });
                    msg.req.seq = seq;
                    setTimeout(() => {
                        this.wsRepRecord.delete(wsId + seq);
                    }, 60000);
                    ws.send(JSON.stringify(msg.req));
                });
            } catch (error) {
                this.logger.error(error.message);
            }
        }
    }

    /**
     * 获取处理 message 事件的函数
     * @param ws
     * @param wsId
     */
    private async getSolveMessage(
        ws: WebSocket,
        wsId: string
    ): Promise<(msg: string) => Promise<void>> {
        return async (msg: string): Promise<void> => {
            let wsMsg: Response | Request<ControllerMethod, ControllerArgs>;
            // try catch 可考虑移除
            try {
                wsMsg = JSON.parse(msg);
            } catch (error) {
                const e = "解析 message 的 JSON 出错";
                await this.log(wsId, e);
                throw new Error(e);
            }
            if (wsMsg.type === "res") {
                const record = this.wsRepRecord.get(wsId + wsMsg.seq);
                if (!record) {
                    const e = "wsMsgRecord 记录不存在";
                    await this.log(wsId, e);
                    throw new Error(e);
                }
                wsMsg.seq = record.seq;
                await this.redisService.client.lpush(
                    record.pid + ResQueueSuf,
                    JSON.stringify(wsMsg)
                );
            } else if (wsMsg.type === "req") {
                const fun = this.methods.get(wsMsg.body.method);
                let error: ErrorInfo | undefined = undefined;
                let output: unknown;
                if (!fun) {
                    error = {
                        code: 400,
                        message: "error method"
                    };
                } else {
                    try {
                        output = (await fun(ws, wsId, wsMsg.body.args)) ?? null;
                    } catch (e) {
                        error = {
                            code: 500,
                            message: e.message
                        };
                    }
                }
                const res: Response = {
                    type: "res",
                    time: moment().format("YYYY-MM-DDTHH:mm:ssZ"),
                    seq: wsMsg.seq,
                    body: { output: null }
                };
                if (error !== undefined) {
                    res.body = { error };
                } else {
                    res.body = { output };
                }
                ws.send(JSON.stringify(res));
            }
        };
    }

    /**
     * 获取处理 close 事件的函数
     * @param ws
     * @param wsId
     */
    private async getSolveClose(
        ws: WebSocket,
        wsId: string
    ): Promise<(code: number, reason: string) => Promise<void>> {
        return async (code: number, reason: string): Promise<void> => {
            const e = `评测机断开连接，原因：${
                reason !== ""
                    ? reason
                    : code === 1000
                    ? "无"
                    : "评测机可能意外断开"
            }`;
            await this.log(wsId, e);
            await this.redisService.client
                .multi()
                .hdel(OnlineToken, wsId)
                .hdel(DisabledToken, wsId)
                .hset(ClosedToken, wsId, Date.now())
                .hdel(LifePing, wsId)
                .srem(process + ProcessOwnWsSuf, wsId)
                .exec();
            await this.removeJudger(wsId);
            this.ownTasks.delete(wsId);
        };
    }

    /**
     * 获取处理 error 事件的函数
     * @param ws
     * @param wsId
     */
    private async getSolveError(
        ws: WebSocket,
        wsId: string
    ): Promise<(e: Error) => Promise<void>> {
        return async (e: Error): Promise<void> => {
            const emsg = `触发 WebSocket 的 error 事件：${e}`;
            await this.removeJudger(wsId);
            await this.forceDisconnect(wsId, emsg);
            await this.log(wsId, emsg);
        };
    }

    /**
     * 用于记录评测机的各种 log
     * msg 不需要携带 wsId 和时间
     * @param wsId
     * @param msg
     */
    private async log(wsId: string, msg: string): Promise<void> {
        await this.redisService.client.lpush(
            wsId + JudgerLogSuf,
            `${moment().format("YYYY-MM-DDTHH:mm:ssZ")} ${msg}`
        );
        this.logger.warn(`评测机 ${wsId.split(".")[0]}: ${msg}`);
    }

    /**
     * 清理 redis 中的记录
     * @param wsId
     */
    private async cleanToken(wsId: string): Promise<void> {
        await this.redisService.client
            .multi()
            .hdel(AllToken, wsId)
            .hdel(LifePing, wsId)
            .hdel(AllReport, wsId)
            .del(wsId + SendMessageQueueSuf)
            .del(wsId + JudgerLogSuf)
            .hdel(UnusedToken, wsId)
            .hdel(OnlineToken, wsId)
            .hdel(DisabledToken, wsId)
            .hdel(ClosedToken, wsId)
            .exec();
    }

    call(
        wsId: string,
        body: { method: JudgerMethod; args: JudgerArgs },
        timeout = 3000
    ): Promise<unknown> {
        return new Promise<unknown>((resolve, reject) => {
            const seq = (this.callSeq = this.callSeq + 1);
            const c: CallRecordItem = {
                cb: (body: { output?: unknown; error?: ErrorInfo }) => {
                    if (body.error) {
                        reject(
                            new Error(
                                `code: ${body.error.code}, message: ${body.error.message}`
                            )
                        );
                    }
                    if (body.output !== undefined) {
                        resolve(body.output);
                    }
                    reject(new Error("Empty Response"));
                    const ctx = this.callRecord.get(seq);
                    if (ctx) clearTimeout(ctx.timer);
                    this.callRecord.delete(seq);
                },
                timer: setTimeout(() => {
                    reject(new Error("Timeout"));
                    this.callRecord.delete(seq);
                }, timeout)
            };
            this.callRecord.set(seq, c);
            const req: Request<JudgerMethod, JudgerArgs> = {
                type: "req",
                time: moment().format("YYYY-MM-DDTHH:mm:ssZ"),
                seq: seq,
                body: body
            };
            const reqMsg: SendMessageQueueItem = {
                pid: process.pid,
                req: req
            };
            this.redisService.client.lpush(
                wsId + SendMessageQueueSuf,
                JSON.stringify(reqMsg)
            );
        });
    }
}
/**
 * 连接后改状态，加心跳检测，通知评测机池
 * 触发 onclose 之后才改状态，删心跳检测，也通知评测机池
 * sendShutdown、sendDisconnect、onerror 通知评测机池
 * 综上，可能多次通知评测机池
 */
