// keyNames in redis
export const AllToken = "AllToken"; // hash
export const LifePing = "LifePing"; // hash
export const AllReport = "JudgerReport"; // hash
export const SendMessageListSuf = ":meaaage"; // list
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
