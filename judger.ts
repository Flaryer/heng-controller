import WebSocket from "ws";
import axios, { AxiosResponse } from "axios";
import crypto from "crypto";

axios
    .get("http://127.0.0.1:8080/judgers/token", {
        data: {
            maxTaskCount: 10,
            name: "judger" + crypto.randomBytes(2).toString("hex")
        },
        responseType: "json"
    })
    .then((e: AxiosResponse) => {
        console.log(e.data["body"]["token"]);
        const ws = new WebSocket(
            `http://127.0.0.1:9000?token=${e.data["body"]["token"]}`
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
                    await axios
                        .put(
                            `http://127.0.0.1:8080/judgers/${transId}/status`,
                            {
                                state: "Judgeing"
                            }
                        );
                    setTimeout(async () => {
                        await axios
                            .post(
                                `http://127.0.0.1:8080/judgers/${transId}/result`,
                                {
                                    result: JSON.stringify({
                                        result: {
                                            res: "ac"
                                        }
                                    })
                                }
                            );
                    }, 100);
                }, 1000);
        });
    });
