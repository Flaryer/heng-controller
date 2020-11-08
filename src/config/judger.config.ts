import { Type } from "class-transformer";
import {
    IsNumber,
    IsPositive,
    Max,
    Min,
    ValidateNested
} from "class-validator";
import { ProfileName } from "src/profile-processor/profile.annoations";

export class WsConfig {
    @IsNumber()
    @Min(1)
    @Max(65535)
    port!: number;

    // ms
    @IsNumber()
    @Min(1000)
    tokenExpire!: number;

    // ms
    @IsNumber()
    @IsPositive()
    reportInterval!: number;

    // ms
    @IsNumber()
    @IsPositive()
    lifeCheckInterval!: number;

    // ms
    @IsNumber()
    @IsPositive()
    clearTokenInterval!: number;

    // ms
    @IsNumber()
    @IsPositive()
    badTokenLifeTime!: number;
}

export class TransConfig {}

@ProfileName("Judger 配置")
export class JudgerConfig {
    @ValidateNested()
    @Type(() => WsConfig)
    ws!: WsConfig;

    @ValidateNested()
    @Type(() => TransConfig)
    trans!: TransConfig;
}
