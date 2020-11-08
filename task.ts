import axios, { AxiosResponse } from "axios";
import crypto, { randomBytes } from "crypto";

setInterval(() => {
    axios
        .get("http://127.0.0.1:8080/judgers/alltoken")
        .then((e: AxiosResponse) => {
            for (const wsId in e.data) {
                if (e.data[wsId]["status"] == 1)
                    axios.get(
                        `http://127.0.0.1:8080/judgers/task/${crypto
                            .randomBytes(4)
                            .toString("hex")}/${wsId}`
                    );
            }
        });
}, 100);
