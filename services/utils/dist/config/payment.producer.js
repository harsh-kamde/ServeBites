import { getChannel } from "./rabbitmq.js";
export const publishPaymentSuccess = async (payload) => {
    const channel = getChannel();
    channel.sendToQueue(process.env.PAYMENT_QUEUE, Buffer.from(JSON.stringify({
        type: "PAYMENT_SUCCESS",
        data: payload,
    })), { persistent: true });
};
