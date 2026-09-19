import amqp from "amqplib";

export const EXCHANGE = "saga.events";
export const DLQ = "saga.dlq";
let channelPromise;

export function getChannel() {
  if (!channelPromise) {
    channelPromise = (async () => {
      const connection = await amqp.connect(process.env.RABBITMQ_URL);
      const channel = await connection.createChannel();
      await channel.assertExchange(EXCHANGE, "topic", { durable: true });
      return channel;
    })();
  }
  return channelPromise;
}

export async function publicarEvento(routingKey, payload) {
  const channel = await getChannel();
  channel.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(payload)), {
    contentType: "application/json",
    persistent: true,
  });
}

export async function suscribirse(nombreCola, routingKeys, manejador) {
  const channel = await getChannel();
  await channel.assertQueue(DLQ, { durable: true });
  const { queue } = await channel.assertQueue(nombreCola, { durable: true });
  for (const key of routingKeys) {
    await channel.bindQueue(queue, EXCHANGE, key);
  }
  channel.consume(queue, async (msg) => {
    if (!msg) return;
    try {
      const evento = JSON.parse(msg.content.toString());
      await manejador(msg.fields.routingKey, evento);
      channel.ack(msg);
    } catch (err) {
      console.error("Error procesando evento:", err);
      const retries = Number(msg.properties.headers?.["x-retries"] || 0);
      const headers = { ...(msg.properties.headers || {}), "x-retries": retries + 1 };
      if (retries < 3) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        channel.publish(EXCHANGE, msg.fields.routingKey, msg.content, {
          contentType: "application/json", persistent: true, headers,
        });
      } else {
        channel.sendToQueue(DLQ, msg.content, { contentType: "application/json", persistent: true, headers, type: msg.fields.routingKey });
      }
      channel.ack(msg);
    }
  });
}
