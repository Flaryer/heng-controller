import { ErrorInfo } from "./dto/http";
import { JudgerMethod, Request } from "./dto/ws";

// keyNames in redis
export const SendMessageQueueSuf = ":WsPendingMeaaage"; // list
export const ResQueueSuf = ":ProcessRes"; // list

export const ProcessLife = "ProcessLife"; // hash
export const ProcessOwnWsSuf = ":ProcessWs"; // set

export const AllToken = "AllToken"; // hash
// export const LifePing = "LifePing"; // hash
export const AllReport = "JudgerReport"; // hash
export const JudgerLogSuf = ":JudgerLog"; // list
export const UnusedToken = "UnusedToken"; // hash
export const OnlineToken = "OnlineToken"; // hash
export const DisabledToken = "DisablesToken"; // hash
export const ClosedToken = "ClosedToken"; // hash

export class Token {
    maxTaskCount!: number;
    coreCount?: number;
    name?: string;
    software?: string;
    ip!: string;
    createTime!: string;
}

export interface SendMessageQueueItem {
    pid: number;
    req: Request<JudgerMethod>;
    closeReason?: string;
}

export interface CallRecordItem {
    cb: (body: { output?: unknown; error?: ErrorInfo }) => void;
    timer: NodeJS.Timeout;
}

export interface WsResRecordItem {
    pid: number;
    seq: number;
}
