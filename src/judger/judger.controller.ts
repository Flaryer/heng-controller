import {
    Body,
    Controller,
    Get,
    Logger,
    Param,
    Post,
    Put,
    Req
} from "@nestjs/common";
import { Request } from "express";
import {
    AuthenticationResponse,
    ResponseType,
    BasicResponse,
    ErrorResponse,
    AckResponse
} from "./http.dto.";
import { TransService } from "./trans.service";
import { WsService } from "./ws.service";
import crypto from "crypto";

@Controller("judgers")
export class JudgerController {
    constructor(
        private readonly wsService: WsService,
        private readonly transService: TransService
    ) {}
    private readonly logger = new Logger("judger controller");

    @Get("token")
    async GetToken(
        @Body("maxTaskCount") maxTaskCount: number,
        @Body("coreCount") coreCount: number,
        @Body("name") name: string,
        @Body("software") software: string,
        @Req() req: Request
    ): Promise<BasicResponse> {
        if (!maxTaskCount) {
            return this.makeErrorResponse(403, "参数不完整");
        }
        try {
            const ip = String(
                req.headers["x-forwarded-for"] ?? "unknown"
            ).split(",")[0];
            coreCount = coreCount ?? 0;
            name = name ?? ip;
            software = software ?? "unknown";
            const res: AuthenticationResponse = {
                type: ResponseType.Authentication,
                body: {
                    token: await this.wsService.getToken(
                        maxTaskCount,
                        coreCount,
                        name,
                        software,
                        ip
                    )
                },
                nonce: this.getNonce()
            };
            return res;
        } catch (error) {
            return this.makeErrorResponse(500, "内部错误");
        }
    }

    @Put(":transId/status")
    async UpdateTaskStatus(
        @Param("transId") transId: string,
        @Body("state") state: string
    ): Promise<BasicResponse> {
        if (!state) {
            return this.makeErrorResponse(403, "参数不完整");
        }
        try {
            this.logger.debug(`${transId} 更新状态为 ${state}`);
            await this.transService.updateJudgeState(transId, state);
            const res: AckResponse = {
                type: ResponseType.Ack,
                body: undefined,
                nonce: this.getNonce()
            };
            return res;
        } catch (error) {
            return this.makeErrorResponse(500, "内部错误");
        }
    }

    @Post(":transId/result")
    async SolveTaskResult(
        @Param("transId") transId: string,
        @Body("result") result: string
    ): Promise<BasicResponse> {
        if (!result) {
            return this.makeErrorResponse(403, "参数不完整");
        }
        try {
            this.logger.debug(`${transId} 更新结果为 ${result}`);
            await this.transService.updateJudgeResult(transId, result);
            const res: AckResponse = {
                type: ResponseType.Ack,
                body: undefined,
                nonce: this.getNonce()
            };
            return res;
        } catch (error) {
            return this.makeErrorResponse(500, "内部错误");
        }
    }

    //-------------------------FIXME/DEBUG------------------------------
    // 测试分发任务
    @Get("task/:taskId/:wsId")
    async testJudgeRequest(
        @Param("taskId") taskId: string,
        @Param("wsId") wsId: string
    ): Promise<void> {
        this.logger.debug(`为评测机 ${wsId} 分发任务 ${taskId}`);
        return await this.transService.distributTask(taskId, wsId);
    }

    @Get("alltrans")
    async getAllTrans(): Promise<{ [key: string]: unknown }> {
        return await this.transService.getTransMap();
    }

    @Get("wstrans")
    async getWsTrans(): Promise<{ [key: string]: unknown }> {
        return await this.transService.getWsAllTrans();
    }

    @Get("life")
    async getHeartBeat(): Promise<{ [key: string]: unknown }> {
        return await this.wsService.getLifeMap();
    }

    @Get("alltoken")
    async getAllToken(): Promise<{ [key: string]: unknown }> {
        return await this.wsService.getTokenMap();
    }

    @Get("report")
    async getReport(): Promise<{ [key: string]: unknown }> {
        return await this.wsService.getReportMap();
    }

    // 测试了 ws.send()
    @Get("shut/:wsId")
    async shutdownWs(@Param("wsId") wsId: string): Promise<void> {
        await this.wsService.sendShutdownMessage(
            wsId,
            true,
            "Get 请求 shutdown"
        );
    }

    // 测试了 ws.close()
    @Get("close/:wsId")
    async closeWs(@Param("wsId") wsId: string): Promise<void> {
        await this.wsService.sendDisconnectMessage(
            wsId,
            1000,
            "Get 请求 close"
        );
    }

    /**
     * 获取 nonce
     * 长度为参数的两倍
     */
    getNonce(): string {
        return crypto.randomBytes(16).toString("hex");
    }

    /**
     * 返回一个 ErrorResponse
     * @param code
     * @param message
     */
    makeErrorResponse(code: number, message: string): ErrorResponse {
        const res: ErrorResponse = {
            type: ResponseType.Error,
            body: {
                code: code,
                message: message
            },
            nonce: this.getNonce()
        };
        return res;
    }

    /**
     * Map 转 Plain Object
     * @param map
     */
    mapToPlainObject(map: Map<string, unknown>): { [key: string]: unknown } {
        const ret: { [key: string]: unknown } = {};
        for (const [key, val] of map.entries()) {
            ret[key] = val;
        }
        return ret;
    }
}
