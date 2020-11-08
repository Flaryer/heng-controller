import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "src/config/config-module/config.service";
import { TransConfig } from "src/config/judger.config";
import { WsService } from "./ws.service";
import crypto from "crypto";
import { Trans } from "./judger.dto";
import { JudgeResult } from "./http.dto.";
import { RedisService } from "src/redis/redis.service";

@Injectable()
export class TransService {
    private logger = new Logger("Trans");
    private transConfig: TransConfig;
    // private transMap = new Map<string, Trans>();
    // private wsAllTrans = new Map<string, Set<string>>();
    readonly TrsMapRdsName = "transMap";
    readonly wsTrsRdsPre = "wsTrans.";

    constructor(
        private readonly configService: ConfigService,
        @Inject(forwardRef(() => WsService))
        private readonly wsService: WsService,
        private readonly redisService: RedisService
    ) {
        // 目前配置为空
        this.transConfig = this.configService.getConfig().judger.trans;

        this.redisService.client.del(this.TrsMapRdsName);
        this.redisService.client.keys(this.wsTrsRdsPre + "*").then(r => {
            r.forEach(async (val: string) => {
                await this.redisService.client.del(val);
            });
        });
    }

    //---------------------------admin[可调用]------------------------------------
    // 请直接读取 redis
    // 目前仅供 debug
    // Map 转 Object：
    // const ret: { [key: string]: boolean } = {};
    // for (const [key, val] of this.tokenMap.entries() {
    //     ret[key] = val;
    // }
    // return ret;
    async getTransMap(): Promise<Record<string, Trans>> {
        return this.redisService.hgetallObj(this.TrsMapRdsName, Trans);
    }
    async getWsAllTrans(): Promise<Record<string, string[]>> {
        const ret: { [key: string]: string[] } = {};
        const allWs = await this.redisService.client.keys(
            this.wsTrsRdsPre + "*"
        );
        for (const ws of allWs) {
            ret[ws] = await this.redisService.client.hkeys(ws);
        }
        return ret;
    }

    //--------------------------与评测机池交互[可调用/请填充]-----------------------------------
    /**
     * 供评测机池发布任务
     * 仅需提供wsId（judgerId）和taskId
     * @param taskId
     * @param wsId
     */
    async distributTask(taskId: string, wsId: string): Promise<void> {
        const transId: string = crypto.randomBytes(16).toString("hex");
        await this.wsService.sendJudgeRequest(wsId, taskId, transId);
        // const allTrans = this.wsAllTrans.get(wsId);
        // if (!allTrans) {
        //     const e = `找不到评测机 ${wsId.split(".")[0]} 的 wsAllTrans 记录`;
        //     this.logger.warn(e);
        //     throw new InternalServerErrorException(e);
        // }
        // allTrans.add(transId);
        await this.redisService.client.hset(
            this.wsTrsRdsPre + wsId,
            transId,
            "1"
        );
        await this.redisService.hsetObj(this.TrsMapRdsName, transId, {
            taskId: taskId,
            wsId: wsId
        });
    }

    /**
     * 一次评测结束后通知评测机池释放一份算力
     * 评测机池 please fill this
     * @param wsId
     */
    private async releaseJudger(wsId: string): Promise<void> {
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
        const transItem = await this.redisService.hgetObj(
            this.TrsMapRdsName,
            transId,
            Trans
        );
        const taskId: string = transItem.taskId;
        // example: return await externalService.updateJudgeState(taskId, state);
    }

    /**
     * 提供 taskId 和 resultObj
     * 外部交互 please fill this
     * @param transId
     * @param judgeResult
     */
    async updateJudgeResult(transId: string, result: string): Promise<void> {
        const transItem = await this.redisService.hgetObj(
            this.TrsMapRdsName,
            transId,
            Trans
        );
        const resultObj: JudgeResult = JSON.parse(result);
        resultObj.taskId = transItem.taskId;
        // await externalService.updateJudgeResult(taskId, resultObj);
        const wsId: string = transItem.wsId;
        await this.redisService.client.hdel(this.wsTrsRdsPre + wsId, transId);
        await this.redisService.client.hdel(this.TrsMapRdsName, transId);
        await this.releaseJudger(wsId);
    }

    //--------------------------提供给 wsService 的接口[不可调用]----------------------------------------
    /**
     * 删除某评测机的所有任务分发记录，拒绝评测机返回的已失效的任务分配的结果
     * @param wsId
     */
    async removeAllTrans(wsId: string): Promise<void> {
        await this.redisService.client.del(this.wsTrsRdsPre + wsId);
    }

    /**
     * 添加一个空的 Array 用于记录该评测机的所有 transId
     * @param wsId
     */
    // async AddEmptyTrans(wsId: string): Promise<void> {
    //     this.wsAllTrans.set(wsId, new Set<string>());
    // }
}
