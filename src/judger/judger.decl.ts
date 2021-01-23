import { ErrorInfo } from "./dto/http";
import { JudgerMethod, Request } from "./dto/ws";

// keyNames in redis
export const SendMessageQueueSuf = ":ws_meaaage"; // list
export const ResQueueSuf = ":process_res"; // list


export const AllToken = "AllToken"; // hash
export const LifePing = "LifePing"; // hash
export const AllReport = "JudgerReport"; // hash
export const SendCloseListSuf = ":close"; // list
export const WarnListSuf = ":warn"; // list
export const JudgerTransSuf = ":trans"; // set
export const TransToTask = "TransToTask"; // hash
export const TransToWs = "TransToWs"; // hash
export enum TokenStatus {
    Unused = "UnusedToken",
    Online = "OnlineToken",
    Closed = "ClosedToken"
} // 3 * set

export class Token {
    maxTaskCount!: number;
    coreCount?: number;
    name?: string;
    software?: string;
    ip!: string;
    createTime!: string;
}

// export interface Message {
//     close: boolean;
//     msg: string;
// }

export interface SendMessageQueueItem {
    pid: number;
    req: Request<JudgerMethod>;
}

export interface CallRecordItem {
    cb: (body: { output?: unknown; error?: ErrorInfo }) => void;
    timer: NodeJS.Timeout;
}

export interface WsMessageRecordItem {
    pid: number;
    seq: number;
}
