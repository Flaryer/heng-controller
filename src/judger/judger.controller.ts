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
    AckResponse,
    AuthenticationResponse,
    BasicResponse,
    ErrorResponse,
    JudgeResult,
    ResponseType
} from "./dto/http.dto";
import { GetToken } from "./dto/judger.dto";
import { JudgerService } from "./judger.service";
import crypto from "crypto";
import { TransformService } from "./transform.service";
import { RedisService } from "src/redis/redis.service";
import { TokenStatus } from "./judger.decl";
import { JudgerGateway } from "./judger.gateway";

@Controller("judger")
export class JudgerController {
    private readonly logger = new Logger("judger controller");
    constructor(
        private readonly judgerService: JudgerService,
        private readonly transformService: TransformService,
        private readonly redisService: RedisService,
        private readonly judgerGateway: JudgerGateway
    ) {}

    @Get("token")
    async getToken(
        @Body() body: GetToken,
        @Req() req: Request
    ): Promise<BasicResponse> {
        try {
            const ip = String(
                req.headers["x-forwarded-for"] ?? "unknown"
            ).split(",")[0];
            const res: AuthenticationResponse = {
                type: ResponseType.Authentication,
                body: {
                    token: await this.judgerGateway.getToken(
                        body.maxTaskCount,
                        body.coreCount ?? 0,
                        body.name ?? ip,
                        body.software ?? "unknown",
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

    @Put("status")
    async multiUpdateTaskStatus(
        @Body("body") allState: { transId: string; state: string }[]
    ): Promise<BasicResponse> {
        if (!allState) {
            return this.makeErrorResponse(403, "参数不完整");
        }
        try {
            allState.forEach(async item => {
                this.logger.debug(`${item.transId} 更新状态为 ${item.state}`);
                await this.transformService.updateJudgeState(
                    item.transId,
                    item.state
                );
            });
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

    @Post("result")
    async multiSolveTaskResult(
        // 以下可以改为
        // @Body("body") allResult: JudgeResult[]
        @Body("body") allResult: { transId: string; result: JudgeResult }[]
    ): Promise<BasicResponse> {
        if (!allResult) {
            return this.makeErrorResponse(403, "参数不完整");
        }

        try {
            allResult.forEach(async item => {
                this.logger.debug(
                    `${item.transId} 更新结果为 ${JSON.stringify(item.result)}`
                );
                await this.transformService.updateJudgeResult(
                    item.transId,
                    item.result
                );
            });
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
            await this.transformService.updateJudgeState(transId, state);
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
        @Body("result") result: JudgeResult
    ): Promise<BasicResponse> {
        if (!result) {
            return this.makeErrorResponse(403, "参数不完整");
        }
        try {
            this.logger.debug(`${transId} 更新结果为 ${result}`);
            await this.transformService.updateJudgeResult(transId, result);
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

    @Post("task")
    async testMultiJudgeRequest(
        @Body("body") allRequest: { taskId: string; wsId: string }[]
    ): Promise<void> {
        allRequest.forEach(async r => {
            this.logger.debug(`为评测机 ${r.wsId} 分发任务 ${r.taskId}`);
            return await this.transformService.distributTask(r.taskId, r.wsId);
        });
    }

    // 测试分发任务
    @Post("task/:taskId/:wsId")
    async testJudgeRequest(
        @Param("taskId") taskId: string,
        @Param("wsId") wsId: string
    ): Promise<void> {
        this.logger.debug(`为评测机 ${wsId} 分发任务 ${taskId}`);
        return await this.transformService.distributTask(taskId, wsId);
    }

    @Get("onlinetoken")
    async getAllToken(): Promise<string[]> {
        return await this.redisService.client.smembers(TokenStatus.Online);
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
}
