import {
    forwardRef,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger
} from "@nestjs/common";
import { ConfigService } from "src/config/config-module/config.service";
import { TransService } from "./trans.service";
import crypto from "crypto";
import http, { IncomingMessage } from "http";
import { WsConfig } from "src/config/judger.config";
import { Token, TokenStatus } from "./judger.dto";
import {
    ErrorMessage,
    MessageType,
    ShutdownMessage,
    StatusReportControlMessage,
    StatusReportPayload,
    DisconnectMessage,
    StatusReportMessage,
    JudgeRequest,
    JudgeRequestMessage
} from "./ws.dto";
import WebSocket from "ws";
import { Socket } from "net";
import moment from "moment";

@Injectable()
export class WsService {
    private logger = new Logger("WebSocket");
    private httpServer: http.Server;
    private wsServer: WebSocket.Server;
    private wsMap = new Map<string, WebSocket>();
    private tokenMap = new Map<string, Token>();
    private reportMap = new Map<string, StatusReportPayload>();
    private wsConfig: WsConfig;
    private lifeMap = new Map<string, boolean>();
    private lifeCheckTimer: NodeJS.Timeout;
    private clearTokenTimer: NodeJS.Timeout;

    constructor(
        private readonly configService: ConfigService,
        @Inject(forwardRef(() => TransService))
        private readonly transService: TransService
    ) {
        // Launch wsServer
        this.wsConfig = this.configService.getConfig().judger.ws;
        this.httpServer = http.createServer().listen(this.wsConfig.port);
        this.wsServer = new WebSocket.Server({ noServer: true });
        this.wsServer.on("connection", this.solveNewConnection);
        this.httpServer.on(
            "upgrade",
            async (req: IncomingMessage, ws: Socket, head: Buffer) => {
                const params = await this.getParams(req.url ?? "");
                if (!(await this.checkToken(params.get("token") ?? "", req))) {
                    ws.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                    ws.destroy();
                    return;
                }
                this.wsServer.handleUpgrade(req, ws, head, ws => {
                    this.wsServer.emit("connection", ws, req);
                });
            }
        );

        // Regular check is_alive
        this.lifeCheckTimer = setInterval(async () => {
            for (const [wsId, is_alive] of this.lifeMap.entries()) {
                if (is_alive) {
                    this.lifeMap.set(wsId, false);
                } else {
                    await this.updateTokenStatus(
                        wsId,
                        TokenStatus.LoseConnection,
                        "长时间未发送心跳"
                    );
                    await this.sendClose(wsId, 1000, "长时间未发送心跳");
                }
            }
            // this.logger.log("已执行心跳检测");
        }, this.wsConfig.lifeCheckInterval);

        // Regular clear token
        this.clearTokenTimer = setInterval(async () => {
            for (const [wsId, tokenItem] of this.tokenMap.entries()) {
                if (
                    tokenItem.status != TokenStatus.Connected &&
                    Date.parse(tokenItem.updateTime) +
                        (tokenItem.status == TokenStatus.Unused
                            ? this.wsConfig.tokenExpire
                            : this.wsConfig.badTokenLifeTime) <
                        Date.now()
                ) {
                    this.tokenMap.delete(wsId);
                    this.reportMap.delete(wsId);
                    this.lifeMap.delete(wsId);
                    const ws = this.wsMap.get(wsId);
                    if (ws) ws.close();
                    this.wsMap.delete(wsId);
                    this.logger.log(`清理失效 token：${wsId}`);
                }
            }
            // this.logger.log("已执行失效 token 清理");
        }, this.wsConfig.clearTokenInterval);
    }

    //---------------------------与评测机池交互[请填充]----------------------
    /**
     * 通知评测机池移除评测机
     * 评测机池 please fill this
     * @param wsId
     */
    private async removeJudger(wsId: string): Promise<void> {
        this.logger.warn(`已请求评测机池移除评测机 ${wsId.split(".")[0]} `);
        await this.transService.removeAllTrans(wsId);
        // await this.poolService.removeJudger(wsId);
    }

    /**
     * 通知评测机池添加评测机
     * 评测机池 please fill this
     * @param wsId
     */
    private async addJudger(wsId: string, maxTaskCount: number): Promise<void> {
        this.logger.warn(`已请求评测机池添加评测机 ${wsId.split(".")[0]} `);
        await this.transService.AddEmptyTrans(wsId);
        // await this.poolService.addJudger(wsId, maxTaskCount);
    }

    //---------------------------外部交互[请填充]--------------------------
    /**
     * 计划是通过外部交互获取评测任务的详细信息
     * 或者注入 redisService 从 redis 读取（由于未知 reids 命名格式，未实施）
     * 外部交互 please fill this
     * @param taskId
     */
    private async getJudgeRequestInfo(taskId: string): Promise<JudgeRequest> {
        // example: return await this.externalService.loadInfoFromRedis(taskId);
        return { taskId: taskId } as JudgeRequest;
    }

    //---------------------------admin[可调用]------------------------------------
    // 后期可能将状态移动到 redis，则可以省略以下三个 getMap 接口
    // 设计略显糟糕
    // Map 转 Object：
    // const ret: { [key: string]: boolean } = {};
    // for (const [key, val] of this.tokenMap.entries() {
    //     ret[key] = val;
    // }
    // return ret;
    async getLifeMap(): Promise<Map<string, boolean>> {
        return this.lifeMap;
    }
    async getTokenMap(): Promise<Map<string, Token>> {
        return this.tokenMap;
    }
    async getReportMap(): Promise<Map<string, StatusReportPayload>> {
        return this.reportMap;
    }

    //------------------------ws/评测机连接 [可调用]-------------------------------
    /**
     * 发送 JudgeRequestMessage
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
        await this.sendMessage(wsId, JSON.stringify(data));
    }

    /**
     * 发送 ReportControlMessage
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
        await this.sendMessage(wsId, JSON.stringify(data));
    }

    /**
     * 要求评测机关机
     * 发送 ShutdownMessage
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
        await this.sendMessage(wsId, JSON.stringify(data));
    }

    /**
     * 控制端主动与评测机断连
     * @param wsId
     * @param code
     * @param reason
     * @param expectedRecoveryTime
     */
    async sendDisconnectMessage(
        wsId: string,
        code = 1000,
        reason?: string,
        expectedRecoveryTime?: string
    ): Promise<void> {
        await this.updateTokenStatus(wsId, TokenStatus.LocalDisconnect, reason);
        await this.sendClose(wsId, code, reason, expectedRecoveryTime);
    }

    //-------------------------------token----------------------------------------
    /**
     * 获取 token
     * @param maxTaskCount
     * @param coreCount
     * @param name
     * @param software
     * @param ip
     */
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

        this.tokenMap.set(token, {
            token: token,
            status: TokenStatus.Unused,
            updateTime: moment().format("YYYY-MM-DDTHH:mm:ssZ"),
            info: {
                maxTaskCount: maxTaskCount,
                coreCount: coreCount,
                name: name,
                software: software,
                ip: ip
            },
            msg: "unused"
        });
        this.logger.log(`ip: ${ip} 获取了 token`);
        return token;
    }

    /**
     * 检验 token
     * @param token
     * @param req
     */
    async checkToken(token: string, req: IncomingMessage): Promise<boolean> {
        const ip = String(req.headers["x-forwarded-for"] ?? "unknown").split(
            ","
        )[0];
        this.logger.warn(`ip: ${ip} 请求登录`);
        const tokenItem = this.tokenMap.get(token);
        if (!tokenItem) {
            this.logger.error("token 不存在：" + token);
            return false;
        }
        if (tokenItem.info.ip != ip) {
            this.logger.error("token 被盗用：" + JSON.stringify(tokenItem));
            return false;
        }
        if (tokenItem.status != TokenStatus.Unused) {
            this.logger.error("token 重复使用：" + JSON.stringify(tokenItem));
            return false;
        }
        if (
            Date.parse(tokenItem.updateTime) + this.wsConfig.tokenExpire <
            Date.now()
        ) {
            this.logger.error("token 过期：" + JSON.stringify(tokenItem));
            return false;
        }
        return true;
    }

    //----------------------------WebSocket 基础部分[不可外部调用]-----------------------
    /**
     * 基础组件
     * ws.send()
     * @param wsId
     * @param str
     */
    private async sendMessage(wsId: string, str: string): Promise<void> {
        const ws = await this.getWs(wsId, false);
        ws.send(str);
    }

    /**
     * ws.Close
     * 发送 DisconnectMessage
     * @param wsId
     * @param code
     * @param reason
     * @param expectedRecoveryTime
     */
    private async sendClose(
        wsId: string,
        code = 1000,
        reason?: string,
        expectedRecoveryTime?: string
    ): Promise<void> {
        this.logger.warn(
            `主动与评测机 ${wsId.split(".")[0]} 请求断开连接，原因：${reason}`
        );
        const ws = await this.getWs(wsId);
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
        ws.close(1000, JSON.stringify(data));
        setTimeout(() => {
            ws.terminate();
        }, 500);
    }

    /**
     * 获取处理新 ws 连接的函数
     * 更新 token 状态
     * 更新 wsMap
     * 绑定 callback
     * 发送 sendReportControlMessage
     * @param ws
     * @param req
     */
    private solveNewConnection = async (
        ws: WebSocket,
        req: IncomingMessage
    ): Promise<void> => {
        const params = await this.getParams(req.url ?? "");
        const wsId = params.get("token");
        if (!wsId) {
            ws.terminate();
            this.logger.error("致命错误：无 token 的连接");
            throw new InternalServerErrorException("致命错误：无 token 的连接");
        }
        this.logger.warn(`评测机 ${wsId.split(".")[0]} 已登录`);
        await this.updateTokenStatus(wsId, TokenStatus.Connected, "已登录");
        this.wsMap.set(wsId, ws);
        ws.on("ping", await this.getSolvePing(wsId));
        ws.on("message", await this.getSolveMessage(wsId));
        ws.on("error", await this.getSolveError(wsId));
        ws.on("close", await this.getSolveClose(wsId));
        await this.sendReportControlMessage(wsId, this.wsConfig.reportInterval);
        // 压测
        // setInterval(() => {
        //     this.transService.distributTask(
        //         crypto.randomBytes(4).toString("hex"),
        //         wsId
        //     );
        // }, 100);
    };

    /**
     * 获取处理 message 事件的函数
     * 目前只处理评测机的 ErrorMessage
     * @param wsId
     */
    private async getSolveMessage(
        wsId: string
    ): Promise<(msg: string) => Promise<void>> {
        return async (msg: string): Promise<void> => {
            let body: ErrorMessage;
            try {
                body = JSON.parse(msg);
            } catch (error) {
                const e = `${wsId.split(".")[0]}：解析 message 的 JSON 时出错`;
                this.logger.error(e);
                throw new InternalServerErrorException(e);
            }
            if (body.type != MessageType.Error) {
                const e = `${wsId.split(".")[0]} 发送了错误的 message 类型：${
                    body.type
                }，请检查。`;
                this.logger.warn(e);
                throw new InternalServerErrorException(e);
            }
            this.logger.warn(
                `评测机 ${wsId.split(".")[0]} 发送内部错误，错误代码：${
                    body.body.code
                }，错误信息：${body.body.message}`
            );
        };
    }

    /**
     * 获取处理 ping 事件的函数
     * 处理评测机的 StatusReportMessage
     * 标记心跳
     * @param wsId
     */
    private async getSolvePing(
        wsId: string
    ): Promise<(data: Buffer) => Promise<void>> {
        return async (data: Buffer): Promise<void> => {
            this.lifeMap.set(wsId, true);
            let body: StatusReportMessage;
            try {
                body = JSON.parse(data.toString("utf-8"));
            } catch (error) {
                const e = `${wsId.split(".")[0]}：解析 ping 的 JSON 时出错`;
                this.logger.error(e);
                throw new InternalServerErrorException(e);
            }
            if (body.type != MessageType.StatusReport) {
                const e = `${wsId.split(".")[0]} 发送了错误的 ping 类型：${
                    body.type
                }，请检查。`;
                this.logger.warn(e);
                throw new InternalServerErrorException(e);
            }
            this.reportMap.set(wsId, body.body);
        };
    }

    /**
     * 获取处理 close 事件的函数
     * 更新状态
     * 解析 DisconnectMessage
     * @param wsId
     */
    private async getSolveClose(
        wsId: string
    ): Promise<(code: number, reason: string) => Promise<void>> {
        return async (code: number, reason: string): Promise<void> => {
            await this.updateTokenStatus(
                wsId,
                TokenStatus.RemoteDisconnect,
                `code: ${code}; reason: ${
                    reason.length ? reason : "评测机可能被强制关闭"
                }`
            );
            let body: DisconnectMessage;
            try {
                body = JSON.parse(reason);
            } catch (error) {
                const e = `${wsId.split(".")[0]}：解析 close 的 JSON 时出错`;
                this.logger.error(e);
                throw new InternalServerErrorException(e);
            }
            this.logger.warn(
                `评测机 ${wsId.split(".")[0]} 于 ${body.body.time ??
                    "无"} 已断连，期望恢复时间：${body.body
                    .expectedRecoveryTime ?? "无"}，错误信息：${body.body
                    .errorInfo.message ?? "无"}`
            );
        };
    }

    /**
     * 获取处理 error 事件的函数
     * 更新状态
     * sendClose
     * @param wsId
     */
    private async getSolveError(
        wsId: string
    ): Promise<(e: Error) => Promise<void>> {
        return async (e: Error): Promise<void> => {
            await this.updateTokenStatus(
                wsId,
                TokenStatus.Error,
                `触发 error 事件：${e}`
            );
            await this.sendClose(wsId, 1000, `触发 error 事件：${e}`);
        };
    }

    /**
     * 解析 url 中 ? 后的内容
     * 返回 Map
     * @param url
     */
    private async getParams(url: string): Promise<Map<string, string>> {
        const params = new Map<string, string>();
        if (url.indexOf("?") != -1) {
            const query: string = url.split("?", 2)[1];
            for (const param of query.split("&")) {
                params.set(param.split("=", 2)[0], param.split("=", 2)[1]);
            }
        }
        return params;
    }

    /**
     * 获取 wsMap 中的记录
     * @param wsId
     */
    private async getWs(wsId: string, noRefuse = true): Promise<WebSocket> {
        const tokenItem = this.tokenMap.get(wsId);
        if (!tokenItem) {
            const e = `处理 ws 连接 ${
                wsId.split(".")[0]
            } 时没有找到 tokenMap 记录，可能传入了不存在的 token`;
            this.logger.error(e);
            throw new InternalServerErrorException(e);
        }
        if (!noRefuse && tokenItem.status != TokenStatus.Connected) {
            const e = `拒绝返回评测机 ${
                wsId.split(".")[0]
            } 的 wsMap记录，因为未连接或已断连`;
            this.logger.warn(e);
            throw new InternalServerErrorException(e);
        }
        const ws = this.wsMap.get(wsId);
        if (!ws) {
            const e = `找不到评测机 ${
                wsId.split(".")[0]
            } 的 wsMap 记录，可能传入了不存在的 token 或评测机未登录`;
            this.logger.error(e);
            await this.updateTokenStatus(
                wsId,
                TokenStatus.Error,
                "找不到 wsMap 记录，可能传入了不存在的 token 或评测机未登录"
            );
            throw new InternalServerErrorException(e);
        }
        return ws;
    }

    /**
     * 改变 token 的状态
     * 主动添加/去除心跳检测
     * 主动通知评测机池
     * @param wsId
     * @param status
     * @param msg
     */
    private async updateTokenStatus(
        wsId: string,
        status: TokenStatus,
        msg = ""
    ): Promise<void> {
        const tokenItem = this.tokenMap.get(wsId);
        if (!tokenItem) {
            const e = `处理 ws 连接 ${
                wsId.split(".")[0]
            } 时没有找到 tokenMap 记录，可能传入了不存在的 token`;
            this.logger.error(e);
            throw new InternalServerErrorException(e);
        }
        // 以下仔细处理，避免 bug
        // 添加心跳检测、通知评测机池
        if (status == TokenStatus.Unused) {
            // 一般不会更改状态为 unused
            tokenItem.status = status;
            tokenItem.updateTime = moment().format("YYYY-MM-DDTHH:mm:ssZ");
            tokenItem.msg = msg;
        } else if (status == TokenStatus.Connected) {
            this.lifeMap.set(wsId, true);
            await this.addJudger(wsId, tokenItem.info.maxTaskCount);
            tokenItem.status = status;
            tokenItem.updateTime = moment().format("YYYY-MM-DDTHH:mm:ssZ");
            tokenItem.msg = msg;
        } else if (
            status == TokenStatus.LoseConnection ||
            status == TokenStatus.LocalDisconnect ||
            status == TokenStatus.RemoteDisconnect ||
            status == TokenStatus.Error
        ) {
            this.lifeMap.delete(wsId);
            // 判断之前未发生过错误/disconnect
            if (tokenItem.status < 100) {
                if (tokenItem.status == TokenStatus.Connected)
                    await this.removeJudger(wsId);
                tokenItem.status = status;
                tokenItem.updateTime = moment().format("YYYY-MM-DDTHH:mm:ssZ");
                tokenItem.msg = msg;
            }
        }
    }

    // 错误/close 处理：1.改变状态（包括：去除心跳检测、通知评测机池）->评测机即刻完全失效->等待自动清理其他残余记录
    //                2.sendClose
    // 错误处理地点：1.close  2.error  3.内部错误  4.长时间失去心跳
    // token = wsId = judgerId
    //----------------------------WebSocket基础部分结束-------------------------------------
}
