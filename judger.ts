import WebSocket from "ws";
import axios, { AxiosResponse } from "axios";
import crypto from "crypto";

let status: { transId: string; state: string }[] = [];
let result: { transId: string; result: any }[] = [];

axios
    .get("http://127.0.0.1:8080/judger/token", {
        data: {
            maxTaskCount: 10,
            name: "judger" + crypto.randomBytes(2).toString("hex")
        }
    })
    .then((e: AxiosResponse) => {
        console.log(e.data["body"]["token"]);
        const ws = new WebSocket(
            `http://127.0.0.1:8080/judger?token=${e.data["body"]["token"]}`
        );
        ws.on("open", function open() {
            setInterval(() => {
                ws.ping(`{ "type": 18,"body":{"hardware":{"cpu":1}} }`);
            }, 1000);
        });
        ws.on("error", e => {
            console.log(e);
            console.log("err");
        });
        ws.on("close", (e, r) => {
            console.log(e, r);
            process.exit();
        });
        ws.on("message", (data: string) => {
            console.log(data);
            const transId = JSON.parse(data)["body"]["taskId"];
            if (JSON.parse(data)["type"] == 33)
                setTimeout(async () => {
                    status.push({ transId, state: "Judging" });
                    setTimeout(async () => {
                        result.push({
                            transId: transId,
                            result: {
                                result: {
                                    res: "ac"
                                }
                            }
                        });
                    }, 100);
                }, 1000);
        });
    });

setInterval(() => {
    if (JSON.stringify(status) !== "[]") {
        axios.put(`http://127.0.0.1:8080/judger/status`, {
            body: Array.from(status)
        });
        status = [];
    }
}, 1000);

setInterval(() => {
    if (JSON.stringify(result) !== "[]") {
        axios.post(`http://127.0.0.1:8080/judger/result`, {
            body: Array.from(result)
        });
        result = [];
    }
}, 1000);
