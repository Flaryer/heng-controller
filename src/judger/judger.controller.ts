import {
    Body,
    Controller,
    Get,
    Logger,
    Param,
    Post,
    Req
} from "@nestjs/common";
import { Request } from "express";
import { JudgerService } from "./judger.service";
import { RedisService } from "src/redis/redis.service";
import { JudgerGateway } from "./judger.gateway";
import { GetToken } from "./dto/judger.dto";
import { AcquireTokenOutput, ErrorInfo } from "./dto/http";
import { OnlineToken } from "./judger.decl";

@Controller("judger")
export class JudgerController {
    private readonly logger = new Logger("judger controller");
    constructor(
        private readonly judgerService: JudgerService,
        private readonly redisService: RedisService,
        private readonly judgerGateway: JudgerGateway
    ) {}

    @Get("token")
    async getToken(
        @Body() body: GetToken,
        @Req() req: Request
    ): Promise<AcquireTokenOutput | ErrorInfo> {
        try {
            const ip = String(
                req.headers["x-forwarded-for"] ?? "unknown"
            ).split(",")[0];
            const res: AcquireTokenOutput = {
                token: await this.judgerGateway.getToken(
                    body.maxTaskCount,
                    body.coreCount ?? 0,
                    body.name ?? ip,
                    body.software ?? "unknown",
                    ip
                )
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
            return await this.judgerGateway.distributTask(r.wsId, r.taskId);
        });
    }

    // 测试分发任务
    @Post("task/:taskId/:wsId")
    async testJudgeRequest(
        @Param("taskId") taskId: string,
        @Param("wsId") wsId: string
    ): Promise<void> {
        this.logger.debug(`为评测机 ${wsId} 分发任务 ${taskId}`);
        return await this.judgerGateway.distributTask(wsId, taskId);
    }

    @Get("onlinetoken")
    async getAllToken(): Promise<string[]> {
        return await this.redisService.client.hkeys(OnlineToken);
    }

    /**
     * 返回一个 ErrorResponse
     * @param code
     * @param message
     */
    makeErrorResponse(code: number, message: string): ErrorInfo {
        const res: ErrorInfo = {
            code: code,
            message: message
        };
        return res;
    }
}
