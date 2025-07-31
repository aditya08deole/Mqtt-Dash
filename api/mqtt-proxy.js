// File: /api/mqtt-proxy.js
import mqtt from 'mqtt';

// These environment variables MUST be set in your Vercel project settings.
const MQTT_BROKER_HOST = process.env.MQTT_BROKER_HOST || 'io.adafruit.com';
const MQTT_BROKER_PORT = process.env.MQTT_BROKER_PORT || '8883';
const ADAFRUIT_IO_USERNAME = process.env.ADAFRUIT_IO_USERNAME;
const ADAFRUIT_IO_KEY = process.env.ADAFRUIT_IO_KEY;

// We now only need one topic, which is used for both status and commands.
const TOPIC_STATUS = `${ADAFRUIT_IO_USERNAME}/feeds/esp32-status`;

/**
 * Main handler for all incoming requests.
 */
export default async function handler(request, response) {
    if (request.method !== 'POST') {
        return response.status(405).json({ status: 'error', details: 'Method Not Allowed' });
    }
    if (!ADAFRUIT_IO_USERNAME || !ADAFRUIT_IO_KEY) {
        return response.status(500).json({ status: 'error', details: 'MQTT credentials are not configured on the server.' });
    }

    const { action, payload } = request.body;

    try {
        if (action === 'send_motor_command') {
            await handlePublish(TOPIC_STATUS, payload);
            return response.status(200).json({ status: 'success', details: 'Command published.' });

        } else if (action === 'get_device_status') {
            const data = await handleGetStatus(TOPIC_STATUS);
            if (data) {
                return response.status(200).json({ status: 'success', data });
            } else {
                return response.status(404).json({ status: 'error', details: 'Status not found. Device may be offline.' });
            }
        } else {
            return response.status(400).json({ status: 'error', details: 'Invalid action specified.' });
        }
    } catch (error) {
        console.error('[PROXY_ERROR]', error.message);
        return response.status(500).json({ status: 'error', details: error.message });
    }
}

/**
 * Publishes a command message to the MQTT topic.
 */
function handlePublish(topic, command) {
    return new Promise((resolve, reject) => {
        const client = mqtt.connect(`mqtts://${MQTT_BROKER_HOST}:${MQTT_BROKER_PORT}`, {
            username: ADAFRUIT_IO_USERNAME,
            password: ADAFRUIT_IO_KEY,
            clientId: `vercel_proxy_pub_${Date.now()}`,
            reconnectPeriod: 0,
        });

        client.on('connect', () => {
            const messagePayload = JSON.stringify({ command: command });
            client.publish(topic, messagePayload, { retain: false }, (err) => {
                client.end();
                if (err) return reject(new Error('Failed to publish message.'));
                resolve();
            });
        });

        client.on('error', (err) => {
            client.end();
            reject(new Error(`MQTT connection failed: ${err.message}`));
        });
    });
}

/**
 * Fetches the last status message and combines it with its timestamp.
 */
async function handleGetStatus(topic) {
    const feedKey = topic.split('/').pop();
    const apiUrl = `https://io.adafruit.com/api/v2/${ADAFRUIT_IO_USERNAME}/feeds/${feedKey}/data/last`;

    const apiResponse = await fetch(apiUrl, {
        headers: { 'X-AIO-Key': ADAFRUIT_IO_KEY },
    });

    if (!apiResponse.ok) {
        if (apiResponse.status === 404) return null;
        throw new Error(`Adafruit API request failed with status ${apiResponse.status}`);
    }

    const data = await apiResponse.json();
    if (!data || !data.value) return null;

    try {
        // Parse the JSON string from the ESP32
        const parsedValue = JSON.parse(data.value);
        
        // **THE FIX**: Combine the parsed data with the Adafruit timestamp
        return {
            ...parsedValue,
            created_at: data.created_at 
        };
    } catch (e) {
        console.error('[JSON_PARSE_ERROR]', 'Failed to parse device status:', data.value);
        throw new Error('Received malformed status data from the device.');
    }
}
