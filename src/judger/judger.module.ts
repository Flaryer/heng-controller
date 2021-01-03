import { Module } from "@nestjs/common";
import { ConfigModule } from "src/config/config-module/config.module";
import { RedisModule } from "src/redis/redis.module";
import { JudgerController } from "./judger.controller";
import { JudgerGateway } from "./judger.gateway";
import { JudgerService } from "./judger.service";
import { TransformService } from "./transform.service";

@Module({
    imports: [RedisModule, ConfigModule],
    providers: [JudgerGateway, JudgerService, TransformService],
    controllers: [JudgerController],
    exports: [TransformService, JudgerGateway]
})
export class JudgerModule {}
