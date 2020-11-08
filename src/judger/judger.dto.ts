export enum TokenStatus {
    Unused = 0,
    Connected = 1,
    LoseConnection = 124,
    LocalDisconnect = 125,
    RemoteDisconnect = 126,
    Error = 127
}
export interface JudgerInfo {
    maxTaskCount: number;
    coreCount: number;
    name: string;
    software: string;
    ip: string;
}

export interface Token {
    token: string;
    status: TokenStatus;
    updateTime: string;
    info: JudgerInfo;
    msg: string;
}

export interface Trans {
    taskId: string;
    wsId: string;
}
