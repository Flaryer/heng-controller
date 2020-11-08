import { Module } from "@nestjs/common";
import { JudgerController } from "./judger.controller";
import { ConfigModule } from "src/config/config-module/config.module";
import { WsService } from "./ws.service";
import { TransService } from "./trans.service";
import { RedisModule } from "src/redis/redis.module";
@Module({
    imports: [ConfigModule, RedisModule],
    providers: [WsService, TransService],
    controllers: [JudgerController],
    exports: [WsService, TransService]
})
export class JudgerModule {}
