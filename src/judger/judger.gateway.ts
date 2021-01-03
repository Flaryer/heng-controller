import {
    forwardRef,
    Inject,
    InternalServerErrorException,
    Logger
} from "@nestjs/common";
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
    TokenStatus,
    SendMessageListSuf,
    SendCloseListSuf,
    WarnListSuf,
    AllReport,
    LifePing,
    AllToken,
    Token,
    JudgerTransSuf
} from "./judger.decl";
import { JudgerService } from "./judger.service";
import {
    DisconnectMessage,
    ErrorMessage,
    JudgeRequest,
    JudgeRequestMessage,
    MessageType,
    ShutdownMessage,
    StatusReportControlMessage,
    StatusReportMessage
} from "./dto/websocket.dto";
import moment from "moment";
import { TransformService } from "./transform.service";
import * as crypto from "crypto";

@WebSocketGateway(undefined, {
    // 此处 path 不生效！检测 path 加在 handleConnection 里面了
    path: "/judger"
})
export class JudgerGateway
    implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
    private readonly logger = new Logger("Gateway");
    private readonly judgerConfig: JudgerConfig;

    constructor(
        private readonly redisService: RedisService,
        private readonly configService: ConfigService,
        private readonly judgerService: JudgerService,
        @Inject(forwardRef(() => TransformService))
        private readonly transformService: TransformService
    ) {
        this.judgerConfig = this.configService.getConfig().judger;

        // 启动时清理 redis 记录
        this.redisService.client.hkeys(AllToken).then(allToken => {
            allToken.forEach(token => {
                // 可以考虑聚合一下 multi
                this.cleanToken(token);
            });
        });
    }

    async afterInit(server: WebSocket.Server): Promise<void> {
        this.logger.log("WebSocket 网关已启动");
        // 心跳检测
        setInterval(async () => {
            let mu = this.redisService.client.pipeline();
            const ret = await this.redisService.client.hgetall(LifePing);
            for (const token in ret) {
                if (ret[token] !== "1") {
                    await this.sendDisconnectMessage(
                        token,
                        MessageType.Error,
                        "长时间未发生心跳"
                    );
                } else {
                    mu = mu.hset(LifePing, token, "0");
                }
            }
            await mu.exec();
        }, this.judgerConfig.lifeCheckInterval);
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
        await this.redisService.client
            .multi()
            .srem(TokenStatus.Unused, token)
            .sadd(TokenStatus.Online, token)
            .hset(LifePing, token, "1")
            .exec();

        client.on("message", await this.getSolveMessage(client, token));
        client.on("ping", await this.getSolvePing(client, token));
        client.on("close", await this.getSolveClose(client, token));
        client.on("error", await this.getSolveError(client, token));

        this.listenMessageList(client, token);
        this.listenCloseList(client, token);
        this.sendReportControlMessage(token, this.judgerConfig.reportInterval);
        await this.logWarn(token, "上线");
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
    async sendJudgeRequest(
        wsId: string,
        taskId: string,
        transId: string
    ): Promise<void> {
        const data: JudgeRequestMessage = {
            type: MessageType.JudgeRequest,
            body: await this.getJudgeRequestInfo(taskId)
        };
        data.body.taskId = transId;
        await this.redisService.client.lpush(
            wsId + SendMessageListSuf,
            JSON.stringify(data)
        );
    }

    /**
     * 发送 ReportControlMessage 到 redis 消息队列
     * 一般情况下无需手动调用
     * @param wsId
     * @param reportInterval
     */
    async sendReportControlMessage(
        wsId: string,
        reportInterval: number
    ): Promise<void> {
        const data: StatusReportControlMessage = {
            type: MessageType.StatusReportControl,
            body: {
                setReportInterval: reportInterval,
                immediate: true
            }
        };
        await this.redisService.client.lpush(
            wsId + SendMessageListSuf,
            JSON.stringify(data)
        );
    }

    /**
     * 要求评测机关机
     * 发送 ShutdownMessage 到 redis 消息队列
     * @param wsId
     * @param reboot
     * @param rebootDelay
     * @param reason
     */
    async sendShutdownMessage(
        wsId: string,
        reboot: boolean,
        reason?: string,
        rebootDelay?: number
    ): Promise<void> {
        const data: ShutdownMessage = {
            type: MessageType.Shutdown,
            body: {
                reboot: reboot,
                rebootDelay: rebootDelay,
                reason: reason
            }
        };
        await this.removeJudger(wsId);
        await this.redisService.client.lpush(
            wsId + SendMessageListSuf,
            JSON.stringify(data)
        );
        const e = `控制端请求评测机关机，原因：${reason}`;
        this.logWarn(wsId, e);
    }

    /**
     * 控制端主动与评测机断连
     * 发生 close 请求到 redis 消息队列
     * @param wsId
     * @param code
     * @param reason
     * @param expectedRecoveryTime
     */
    async sendDisconnectMessage(
        wsId: string,
        code: number,
        reason?: string,
        expectedRecoveryTime?: string
    ): Promise<void> {
        const data: DisconnectMessage = {
            type: MessageType.Disconnect,
            body: {
                time: moment().format("YYYY-MM-DDTHH:mm:ssZ"),
                expectedRecoveryTime: expectedRecoveryTime,
                errorInfo: {
                    code: code,
                    message: reason
                }
            }
        };
        await this.removeJudger(wsId);
        await this.redisService.client.lpush(
            wsId + SendCloseListSuf,
            JSON.stringify(data)
        );
        const e = `控制端请求断开连接，原因：${reason}`;
        this.logWarn(wsId, e);
    }

    //---------------------------外部交互[请填充]--------------------------
    /**
     * 外部交互 please fill this
     * 获取 redis 中某任务的详细信息
     * @param taskId
     */
    private async getJudgeRequestInfo(taskId: string): Promise<JudgeRequest> {
        return { taskId: taskId } as JudgeRequest;
        // return (await this.redisService.client.hget("Task", taskId)) as JudgeRequest;
    }

    //---------------------------与评测机池交互[请填充]----------------------
    /**
     * 通知评测机池移除评测机
     * 评测机池 please fill this
     * @param wsId
     */
    private async removeJudger(wsId: string): Promise<void> {
        // 以下顺序不可调换
        this.logWarn(wsId, "已请求评测机池移除此评测机");
        await this.transformService.removeAllTrans(wsId);
        // await this.poolService.removeJudger(wsId);
    }

    /**
     * 通知评测机池添加评测机
     * 评测机池 please fill this
     * @param wsId
     */
    private async addJudger(wsId: string): Promise<void> {
        this.logWarn(wsId, "已请求评测机池添加此评测机");
        // const judgerInfo = JSON.parse(
        //     await this.redisService.client.hget(AllToken, wsId)
        // ) as Token;
        // await this.poolService.addJudger(wsId, judgerInfo.maxTaskCount);
        // await this.transService.AddEmptyTrans(wsId);
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
            .sadd(TokenStatus.Unused, token)
            .exec();
        this.logWarn(token, e);
        this.logger.log(e);
        return token;
    }

    async checkToken(token: string, ip: string): Promise<boolean> {
        if (
            !(await this.redisService.client.sismember(
                TokenStatus.Unused,
                token
            ))
        ) {
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
    async listenMessageList(ws: WebSocket, wsId: string): Promise<void> {
        while (ws && ws.readyState <= WebSocket.OPEN) {
            await this.redisService.withClient(async client => {
                const msg = await client.brpop(
                    wsId + SendMessageListSuf,
                    this.judgerConfig.msgQueueTimeoutSec
                );
                if (msg) ws.send(msg[1]);
            });
        }
    }

    /**
     * 监听 close 消息队列
     * @param ws
     * @param wsId
     */
    async listenCloseList(ws: WebSocket, wsId: string): Promise<void> {
        while (ws && ws.readyState <= WebSocket.OPEN) {
            await this.redisService.withClient(async client => {
                const msg = await client.brpop(
                    wsId + SendCloseListSuf,
                    this.judgerConfig.msgQueueTimeoutSec
                );
                if (msg) ws.close(1000, msg[1]);
            });
        }
    }

    /**
     * 获取处理 message 事件的函数
     * 目前只处理评测机的 ErrorMessage
     * @param ws
     * @param wsId
     */
    private async getSolveMessage(
        ws: WebSocket,
        wsId: string
    ): Promise<(msg: string) => Promise<void>> {
        return async (msg: string): Promise<void> => {
            let body: ErrorMessage;
            try {
                body = JSON.parse(msg);
            } catch (error) {
                const e = "解析 message 的 JSON 时出错";
                await this.logWarn(wsId, e);
                throw new InternalServerErrorException(e);
            }
            if (body.type != MessageType.Error) {
                const e = `发送了错误的 message 类型：${body.type}`;
                await this.logWarn(wsId, e);
                throw new InternalServerErrorException(e);
            }
            const e = `发生内部错误，错误代码：${body.body.code}，错误信息：${body.body.message}`;
            await this.logWarn(wsId, e);
        };
    }

    /**
     * 获取处理 ping 事件的函数
     * 处理评测机的 StatusReportMessage
     * 标记心跳
     * @param ws
     * @param wsId
     */
    private async getSolvePing(
        ws: WebSocket,
        wsId: string
    ): Promise<(data: Buffer) => Promise<void>> {
        return async (data: Buffer): Promise<void> => {
            await this.redisService.client.hset(LifePing, wsId, "1");
            let body: StatusReportMessage;
            try {
                body = JSON.parse(data.toString("utf-8"));
            } catch (error) {
                const e = "解析 ping 的 JSON 时出错";
                await this.logWarn(wsId, e);
                throw new InternalServerErrorException(e);
            }
            if (body.type != MessageType.StatusReport) {
                const e = `发送了错误的 ping 类型：${body.type}`;
                await this.logWarn(wsId, e);
                throw new InternalServerErrorException(e);
            }
            await this.redisService.client.hset(
                AllReport,
                wsId,
                JSON.stringify(body)
            );
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
            let e: string;
            if (reason.length) {
                let body: DisconnectMessage;
                try {
                    body = JSON.parse(reason);
                } catch (error) {
                    const e = "解析 close 的 JSON 时出错";
                    await this.logWarn(wsId, e);
                    throw new InternalServerErrorException(e);
                }
                e = `于 ${body.body.time ??
                    "未知时间"} 断连，期望恢复时间：${body.body
                    .expectedRecoveryTime ?? "无"}，错误信息：${body.body
                    .errorInfo.message ?? "无"}`;
            } else {
                e = "可能被强制关闭";
            }
            await this.logWarn(wsId, e);
            await this.redisService.client
                .multi()
                .srem(TokenStatus.Online, wsId)
                .sadd(TokenStatus.Closed, wsId)
                .hdel(LifePing, wsId)
                .exec();
            await this.removeJudger(wsId);
            setTimeout(() => {
                this.cleanToken(wsId);
            }, this.judgerConfig.cleanTokenTimeout);
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
            await this.sendDisconnectMessage(wsId, MessageType.Error, emsg);
            await this.logWarn(wsId, emsg);
            await this.removeJudger(wsId);
        };
    }

    /**
     * 用于记录评测机的各种 log
     * @param wsId
     * @param msg
     */
    private async logWarn(wsId: string, msg: string): Promise<void> {
        await this.redisService.client.lpush(
            wsId + WarnListSuf,
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
            .del(wsId + SendMessageListSuf)
            .del(wsId + SendCloseListSuf)
            .del(wsId + WarnListSuf)
            .del(wsId + JudgerTransSuf)
            .srem(TokenStatus.Unused, wsId)
            .srem(TokenStatus.Online, wsId)
            .srem(TokenStatus.Closed, wsId)
            .exec();
    }
}
/**
 * 连接后改状态，加心跳检测，通知评测机池
 * 触发 onclose 之后才改状态，删心跳检测，也通知评测机池
 * sendShutdown、sendDisconnect、onerror 通知评测机池
 * 综上，可能多次通知评测机池
 */
