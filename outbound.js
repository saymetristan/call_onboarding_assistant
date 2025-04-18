import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";

// Load environment variables from .env file
dotenv.config();

// Check for required environment variables
const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER
) {
  console.error("Missing required environment variables");
  throw new Error("Missing required environment variables");
}

// Initialize Fastify server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Initialize Twilio client
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Helper function to get signed URL for authenticated conversations
async function getSignedUrl() {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        method: "GET",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }

    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error("Error getting signed URL:", error);
    throw error;
  }
}

// Route to initiate outbound calls
fastify.post("/outbound-call", async (request, reply) => {
  // Extraer todos los parámetros del cuerpo de la solicitud
  const { 
    phone_number,  // Renombrado de "number" a "phone_number"
    name = "Cliente", 
    organization = "Datágora", 
    credit_amount = "50000",
    client_id = "",
    prompt = "",       // Mantener para retrocompatibilidad
    first_message = "" // Mantener para retrocompatibilidad
  } = request.body;

  if (!phone_number) {
    return reply.code(400).send({ error: "Phone number is required" });
  }

  try {
    // Construir una URL con todos los parámetros
    const twimlUrl = new URL(`https://${request.headers.host}/outbound-call-twiml`);
    
    // Añadir todos los parámetros a la URL
    twimlUrl.searchParams.append("phone_number", phone_number);
    twimlUrl.searchParams.append("name", name);
    twimlUrl.searchParams.append("organization", organization);
    twimlUrl.searchParams.append("credit_amount", credit_amount);
    twimlUrl.searchParams.append("client_id", client_id);
    twimlUrl.searchParams.append("prompt", prompt);
    twimlUrl.searchParams.append("first_message", first_message);

    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: phone_number,
      url: twimlUrl.toString(),
    });

    reply.send({
      success: true,
      message: "Call initiated",
      callSid: call.sid,
    });
  } catch (error) {
    console.error("Error initiating outbound call:", error);
    reply.code(500).send({
      success: false,
      error: "Failed to initiate call",
    });
  }
});

// TwiML route for outbound calls
fastify.all("/outbound-call-twiml", async (request, reply) => {
  // Extraer todos los parámetros de la consulta
  const { 
    phone_number = "", 
    name = "", 
    organization = "", 
    credit_amount = "",
    client_id = "",
    prompt = "",
    first_message = ""
  } = request.query;

  // Crear el TwiML con todos los parámetros
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/outbound-media-stream">
            <Parameter name="phone_number" value="${phone_number}" />
            <Parameter name="name" value="${name}" />
            <Parameter name="organization" value="${organization}" />
            <Parameter name="credit_amount" value="${credit_amount}" />
            <Parameter name="client_id" value="${client_id}" />
            <Parameter name="prompt" value="${prompt}" />
            <Parameter name="first_message" value="${first_message}" />
          </Stream>
        </Connect>
      </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for handling media streams
fastify.register(async fastifyInstance => {
  fastifyInstance.get(
    "/outbound-media-stream",
    { websocket: true },
    (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");

      // Variables to track the call
      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null; // Add this to store parameters
      let audioPacketCount = 0;
      let isCallActive = false;

      // Handle WebSocket errors
      ws.on("error", console.error);

      // Set up ElevenLabs connection
      const setupElevenLabs = async () => {
        try {
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            // Send only dynamic variables without overriding prompt or first message
            const initialConfig = {
              type: "conversation_initiation_client_data",
              dynamic_variables: {
                "client_id": customParameters?.client_id || callSid || "unknown_call",
                "phone_number": customParameters?.phone_number || "unknown_number",
                "name": customParameters?.name || "Cliente", 
                "organization": customParameters?.organization || "Datágora",
                "credit_amount": customParameters?.credit_amount || "50000"
              }
            };

            console.log(
              "[ElevenLabs] Sending initial config with dynamic variables"
            );

            // Send the configuration to ElevenLabs
            elevenLabsWs.send(JSON.stringify(initialConfig));
          });

          elevenLabsWs.on("message", data => {
            try {
              const message = JSON.parse(data);
              
              // Mostrar mensajes completos para ciertos tipos
              if (message.type === "error" || 
                  message.type === "user_transcript" || 
                  message.error_event) {
                console.log("[ElevenLabs] FULL MESSAGE:", JSON.stringify(message));
              } else {
                console.log("[ElevenLabs] Raw message:", JSON.stringify(message).substring(0, 200) + "...");
              }

              switch (message.type) {
                case "conversation_initiation_metadata":
                  console.log("[ElevenLabs] Received initiation metadata");
                  break;

                case "audio":
                  if (streamSid) {
                    if (message.audio?.chunk) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio.chunk,
                        },
                      };
                      ws.send(JSON.stringify(audioData));
                    } else if (message.audio_event?.audio_base_64) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio_event.audio_base_64,
                        },
                      };
                      ws.send(JSON.stringify(audioData));
                    }
                  } else {
                    console.log(
                      "[ElevenLabs] Received audio but no StreamSid yet"
                    );
                  }
                  break;

                case "interruption":
                  if (streamSid) {
                    ws.send(
                      JSON.stringify({
                        event: "clear",
                        streamSid,
                      })
                    );
                  }
                  break;

                case "ping":
                  if (message.ping_event?.event_id) {
                    elevenLabsWs.send(
                      JSON.stringify({
                        type: "pong",
                        event_id: message.ping_event.event_id,
                      })
                    );
                  }
                  break;

                case "agent_response":
                  console.log(
                    `[Twilio] Agent response: ${message.agent_response_event?.agent_response}`
                  );
                  break;

                case "user_transcript":
                  console.log(
                    `[Twilio] User transcript: ${message.user_transcription_event?.user_transcript}`
                  );
                  break;

                default:
                  console.log(
                    `[ElevenLabs] Unhandled message type: ${message.type}`
                  );
              }

              console.log('[ElevenLabs] Message received type:', message.type);
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
            }
          });

          elevenLabsWs.on("error", error => {
            console.error("[ElevenLabs] WebSocket error details:", error.message);
            // Intentar reconectar después de un error
            setTimeout(setupElevenLabs, 3000);
          });

          elevenLabsWs.on("close", (code, reason) => {
            console.log(`[ElevenLabs] Disconnected with code ${code}. Reason: ${reason || 'No reason provided'}`);
            
            // Solo terminar la llamada de Twilio si ElevenLabs se desconecta pero la llamada sigue activa
            if (isCallActive && streamSid) {
              console.log("[Twilio] Ending call because ElevenLabs disconnected");
              
              // Enviar mensaje de finalización a Twilio
              ws.send(JSON.stringify({
                event: "stop",
                streamSid
              }));
              
              // Marcar llamada como inactiva
              isCallActive = false;
              
              // Opcionalmente cerrar también el WebSocket de Twilio después de un breve retraso
              setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.close();
                }
              }, 2000);
            }
            
            // Solo intentar reconectar si fue una desconexión anormal Y la llamada sigue activa
            if (code !== 1000 && isCallActive) {
              console.log("[ElevenLabs] Attempting to reconnect in 3 seconds...");
              setTimeout(setupElevenLabs, 3000);
            } else {
              console.log("[ElevenLabs] Not reconnecting as call is no longer active");
            }
          });
        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };

      // Set up ElevenLabs connection
      setupElevenLabs();

      // Handle messages from Twilio
      ws.on("message", message => {
        try {
          const msg = JSON.parse(message);
          if (msg.event !== "media") {
            console.log(`[Twilio] Received event: ${msg.event}`);
          }

          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              customParameters = msg.start.customParameters;
              isCallActive = true;
              console.log(
                `[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`
              );
              console.log("[Twilio] Start parameters:", customParameters);
              break;

            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                // UTILIZAR EXACTAMENTE EL MISMO FORMATO QUE EL EJEMPLO DE ELEVENLABS
                const audioMessage = {
                  user_audio_chunk: Buffer.from(
                    msg.media.payload,
                    "base64"
                  ).toString("base64"),
                };
                
                // Solo agregar un punto para feedback visual
                process.stdout.write(".");
                
                elevenLabsWs.send(JSON.stringify(audioMessage));
              }
              break;

            case "stop":
              console.log(`[Twilio] Stream ${streamSid} ended`);
              isCallActive = false;
              
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                console.log("[Twilio] Closing ElevenLabs connection because call ended");
                elevenLabsWs.close(1000, "Call ended normally");
              }
              break;

            default:
              console.log(`[Twilio] Unhandled event: ${msg.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      // Handle WebSocket closure
      ws.on("close", () => {
        console.log("[Twilio] Client disconnected");
        isCallActive = false;
        
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close(1000, "Twilio client disconnected");
        }
      });
    }
  );
});

// Start the Fastify server
fastify.listen({ 
  port: PORT,
  host: '0.0.0.0'  // Escuchar en todas las interfaces, importante para Railway
}, err => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
});
