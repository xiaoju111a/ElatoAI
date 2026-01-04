import { Buffer } from "node:buffer";
import type { RawData } from "npm:@types/ws";
import { WebSocket } from "npm:ws";
import { addConversation, getDeviceInfo } from "../supabase.ts";
import { createOpusPacketizer, isDev, doubaoAppId, doubaoToken, defaultDoubaoVoice } from "../utils.ts";

// 豆包实时语音 WebSocket 地址
const DOUBAO_REALTIME_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";

export const connectToDoubao = async ({
    ws,
    payload,
    connectionPcmFile,
    firstMessage,
    systemPrompt,
    closeHandler,
}: ProviderArgs) => {
    const { user, supabase } = payload;

    if (!doubaoAppId || !doubaoToken) {
        throw new Error("DOUBAO_APP_ID or DOUBAO_TOKEN is not set");
    }

    const voice = user.personality?.oai_voice ?? defaultDoubaoVoice;
    
    const opus = createOpusPacketizer((packet) => ws.send(packet));

    // 构建 WebSocket URL with query params
    const wsUrl = new URL(DOUBAO_REALTIME_URL);
    
    const doubaoWs = new WebSocket(wsUrl.toString(), {
        headers: {
            "Authorization": `Bearer; ${doubaoToken}`,
        },
    });

    let isConnected = false;
    const messageQueue: RawData[] = [];
    let createdSent = false;
    let outputTranscript = "";
    let reqId = crypto.randomUUID();

    const sendResponseCreated = async () => {
        try {
            const device = await getDeviceInfo(supabase, user.user_id);
            opus.reset();
            ws.send(
                JSON.stringify({
                    type: "server",
                    msg: "RESPONSE.CREATED",
                    volume_control: device?.volume ?? 100,
                }),
            );
        } catch {
            ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.CREATED" }));
        }
    };

    // 发送初始化配置
    const sendSessionConfig = () => {
        const config = {
            header: {
                message_id: crypto.randomUUID(),
                namespace: "SpeechToText",
                name: "StartTranscription",
                appid: doubaoAppId,
            },
            payload: {
                // ASR 配置
                asr: {
                    language: "zh-CN",
                    format: "pcm",
                    sample_rate: 16000,
                    enable_punctuation: true,
                    enable_itn: true,
                },
                // TTS 配置
                tts: {
                    voice_type: voice,
                    encoding: "pcm",
                    sample_rate: 24000,
                    speed_ratio: 1.0,
                    volume_ratio: 1.0,
                    pitch_ratio: 1.0,
                },
                // LLM 配置
                llm: {
                    model_name: "doubao-1.5-pro-32k",
                    system_messages: [
                        {
                            role: "system",
                            content: systemPrompt,
                        }
                    ],
                },
            },
        };
        
        doubaoWs.send(JSON.stringify(config));
        console.log("[Doubao] Session config sent");
    };

    // 发送首条消息
    const sendFirstMessage = () => {
        if (!firstMessage) return;
        
        const msg = {
            header: {
                message_id: crypto.randomUUID(),
                namespace: "SpeechToText",
                name: "TextInput",
                appid: doubaoAppId,
            },
            payload: {
                text: firstMessage,
            },
        };
        
        doubaoWs.send(JSON.stringify(msg));
        console.log("[Doubao] First message sent");
    };

    doubaoWs.on("open", () => {
        isConnected = true;
        console.log("[Doubao] WebSocket connected");
        
        sendSessionConfig();
        
        // 延迟发送首条消息
        setTimeout(() => {
            sendFirstMessage();
        }, 500);

        // 处理队列中的消息
        while (messageQueue.length > 0) {
            const queuedMessage = messageQueue.shift();
            if (queuedMessage) {
                messageHandler(queuedMessage, true);
            }
        }
    });

    doubaoWs.on("message", async (data: Buffer) => {
        try {
            // 尝试解析为 JSON
            const message = JSON.parse(data.toString("utf-8"));
            
            const { header, payload } = message;
            const eventName = header?.name;
            
            console.log("[Doubao] Event:", eventName);

            switch (eventName) {
                case "TranscriptionStarted":
                    console.log("[Doubao] Transcription started");
                    break;

                case "SentenceBegin":
                    // 用户开始说话
                    break;

                case "SentenceEnd":
                    // 用户说话结束，获取转写结果
                    if (payload?.result) {
                        const transcript = payload.result;
                        console.log("[Doubao] User said:", transcript);
                        await addConversation(supabase, "user", transcript, user);
                    }
                    break;

                case "LLMResponseBegin":
                    // AI 开始响应
                    if (!createdSent) {
                        await sendResponseCreated();
                        createdSent = true;
                    }
                    break;

                case "LLMResponseDelta":
                    // AI 响应文本增量
                    if (payload?.delta) {
                        outputTranscript += payload.delta;
                    }
                    break;

                case "LLMResponseEnd":
                    // AI 响应结束
                    console.log("[Doubao] LLM response end");
                    break;

                case "TTSResponse":
                    // TTS 音频数据
                    if (payload?.audio) {
                        const pcmChunk = Buffer.from(payload.audio, "base64");
                        opus.push(pcmChunk);
                    }
                    break;

                case "TTSEnd":
                    // TTS 结束
                    opus.flush(true);
                    
                    if (outputTranscript) {
                        await addConversation(supabase, "assistant", outputTranscript, user);
                        outputTranscript = "";
                    }
                    
                    ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.COMPLETE" }));
                    createdSent = false;
                    break;

                case "Error":
                    console.error("[Doubao] Error:", payload);
                    ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.ERROR" }));
                    createdSent = false;
                    break;
            }
        } catch (e) {
            // 可能是二进制音频数据
            if (data instanceof Buffer && data.length > 0) {
                opus.push(data);
            }
        }
    });

    doubaoWs.on("close", () => {
        console.log("[Doubao] WebSocket closed");
        ws.close();
    });

    doubaoWs.on("error", (error: any) => {
        console.error("[Doubao] WebSocket error:", error.message || error);
        ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.ERROR" }));
    });

    const messageHandler = async (data: RawData, isBinary: boolean) => {
        if (isBinary) {
            // 发送音频数据到豆包
            const audioMsg = {
                header: {
                    message_id: crypto.randomUUID(),
                    namespace: "SpeechToText",
                    name: "AudioData",
                    appid: doubaoAppId,
                },
                payload: {
                    audio: (data as Buffer).toString("base64"),
                    is_end: false,
                },
            };
            
            doubaoWs.send(JSON.stringify(audioMsg));

            if (isDev && connectionPcmFile) {
                await connectionPcmFile.write(data as Buffer);
            }
            return;
        }

        // 处理 JSON 指令
        let message: any;
        try {
            message = JSON.parse((data as Buffer).toString("utf-8"));
        } catch {
            return;
        }

        if (message?.type !== "instruction") return;

        if (message.msg === "end_of_speech") {
            // 发送音频结束标记
            const endMsg = {
                header: {
                    message_id: crypto.randomUUID(),
                    namespace: "SpeechToText",
                    name: "AudioData",
                    appid: doubaoAppId,
                },
                payload: {
                    audio: "",
                    is_end: true,
                },
            };
            
            doubaoWs.send(JSON.stringify(endMsg));
            ws.send(JSON.stringify({ type: "server", msg: "AUDIO.COMMITTED" }));
        } else if (message.msg === "INTERRUPT") {
            // 中断当前响应
            const interruptMsg = {
                header: {
                    message_id: crypto.randomUUID(),
                    namespace: "SpeechToText",
                    name: "StopTranscription",
                    appid: doubaoAppId,
                },
                payload: {},
            };
            
            doubaoWs.send(JSON.stringify(interruptMsg));
        }
    };

    ws.on("message", (data: RawData, isBinary: boolean) => {
        if (!isConnected) {
            messageQueue.push(data);
        } else {
            messageHandler(data, isBinary);
        }
    });

    ws.on("error", (error: any) => {
        console.error("[Doubao] ESP32 WebSocket error:", error);
        doubaoWs.close();
    });

    ws.on("close", async (code: number, reason: string) => {
        console.log(`[Doubao] ESP32 WebSocket closed with code ${code}, reason: ${reason}`);
        await closeHandler();
        opus.close();
        doubaoWs.close();
        if (isDev && connectionPcmFile) {
            connectionPcmFile.close();
        }
    });

    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Doubao connection timeout")), 10000);
        doubaoWs.on("open", () => {
            clearTimeout(timeout);
            resolve();
        });
        doubaoWs.on("error", (error: any) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
};
