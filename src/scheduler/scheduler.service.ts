import { Injectable } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import { JudgerService } from "src/judger/judger.service";
import { RedisService } from "src/redis/redis.service";
import { JudgeQueueService } from "./judge-queue-service/judge-queue-service.service";
import { JudgerPoolService } from "./judger-pool/judger-pool.service";

@Injectable()
export class SchedulerService {
    private readonly logger = new Logger("SchedulerService");
    constructor(
        private readonly judgeQueue: JudgeQueueService,
        private readonly judgerPoolService: JudgerPoolService,
        private readonly judgerService: JudgerService,
        private readonly redisService: RedisService
    ) {
        this.run();
        // FIXME 压测
        // setInterval(() => {
        //     this.judgeQueue.push(
        //         Math.random()
        //             .toString(35)
        //             .slice(2)
        //     );
        // }, 50);
    }

    async run(): Promise<void> {
        while (true) {
            let taskId = "",
                token = "",
                backupKeyName = "";
            try {
                token = await this.judgerPoolService.getToken();
                [backupKeyName, taskId] = await this.judgeQueue.pop();

                await this.judgerService.distributeTask(token, taskId);

                await this.redisService.client.del(backupKeyName);
            } catch (error) {
                await this.judgeQueue.restoreBackupTask(backupKeyName);
                if (token) await this.judgerPoolService.releaseToken(token, 1);
                this.logger.error(error);
            }
        }
    }
}
