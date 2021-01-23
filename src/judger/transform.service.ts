import {
    forwardRef,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger
} from "@nestjs/common";
import { RedisService } from "src/redis/redis.service";
import { JudgerConfig } from "src/config/judger.config";
import { ConfigService } from "src/config/config-module/config.service";
import crypto from "crypto";
import { JudgerGateway } from "./judger.gateway";
import {
    TransToTask,
    JudgerTransSuf,
    TransToWs,
    TokenStatus
} from "./judger.decl";
import { JudgeResult } from "./dto/http";

@Injectable()
export class TransformService {
    private logger = new Logger("Transform");
    private readonly judgerConfig: JudgerConfig;

    constructor(
        private readonly redisService: RedisService,
        private readonly configService: ConfigService,
        @Inject(forwardRef(() => JudgerGateway))
        private readonly judgerGateway: JudgerGateway
    ) {
        this.judgerConfig = this.configService.getConfig().judger;

        // 启动时清理 redis 记录
        this.redisService.client
            .multi()
            .del(TransToTask)
            .del(TransToWs)
            .exec();
    }

    //--------------------------与评测机池交互[可调用/请填充]-------------------------
    /**
     * 供评测机池发布任务
     * 仅需提供wsId（judgerId）和taskId
     * @param taskId
     * @param wsId
     */
    async distributTask(taskId: string, wsId: string): Promise<void> {
        if (
            !(await this.redisService.client.sismember(
                TokenStatus.Online,
                wsId
            ))
        ) {
            throw new InternalServerErrorException("Judger 不可用");
        }
        const transId: string = crypto.randomBytes(16).toString("hex");
        await this.judgerGateway.callJudge(wsId, taskId, transId);
        await this.redisService.client
            .multi()
            .sadd(wsId + JudgerTransSuf, transId)
            .hset(TransToTask, transId, taskId)
            .hset(TransToWs, transId, wsId)
            .exec();
    }

    /**
     * 一次评测结束后通知评测机池释放一份算力
     * 评测机池 please fill this
     * @param wsId
     */
    private async releaseJudger(wsId: string, taskId: string): Promise<void> {
        this.logger.debug(
            `已请求评测机池释放评测机 ${wsId.split(".")[0]} 的一份算力`
        );
        //......
    }

    //--------------------------外部交互[请填充]--------------------------------------
    /**
     * 提供 taskId 和 state
     * 外部交互 please fill this
     * @param transId
     * @param judgeState
     */
    async updateJudgeState(transId: string, state: string): Promise<void> {
        const taskId = await this.redisService.client.hget(
            TransToTask,
            transId
        );
        if (!taskId) {
            const e = "transId 不存在，可能已被清理";
            this.logger.warn(e);
            throw new InternalServerErrorException(e);
        }
        // example: return await externalService.updateJudgeState(taskId, state);
    }

    /**
     * 提供 taskId 和 resultObj
     * 外部交互 please fill this
     * @param transId
     * @param judgeResult
     */
    async updateJudgeResult(
        transId: string,
        result: JudgeResult
    ): Promise<void> {
        const ret = await this.redisService.client
            .multi()
            .hget(TransToTask, transId)
            .hget(TransToWs, transId)
            .exec();
        const taskId = ret[0][1];
        const wsId = ret[1][1];
        if (
            !taskId ||
            !wsId ||
            typeof taskId !== "string" ||
            typeof wsId !== "string"
        ) {
            const e = "transId 不存在，可能已被清理";
            this.logger.warn(e);
            throw new InternalServerErrorException(e);
        }
        result.taskId = taskId;

        // await externalService.updateJudgeResult(taskId, judgeResult);

        await this.redisService.client
            .multi()
            .srem(wsId + JudgerTransSuf, transId)
            .hdel(TransToTask, transId)
            .hdel(TransToWs, transId)
            .exec();
        await this.releaseJudger(wsId, taskId);
    }

    //--------------------------提供给 wsService 的接口[不可调用]----------------------------------------
    /**
     * 删除某评测机的所有任务分发记录，拒绝评测机返回的已失效的任务分配的结果
     * @param wsId
     */
    async removeAllTrans(wsId: string): Promise<void> {
        const allTrans = await this.redisService.client.smembers(
            wsId + JudgerTransSuf
        );
        let mu = this.redisService.client.multi();
        allTrans.forEach(transId => {
            mu = mu.hdel(TransToTask, transId).hdel(TransToWs, transId);
        });
        await mu.exec();
    }
}
