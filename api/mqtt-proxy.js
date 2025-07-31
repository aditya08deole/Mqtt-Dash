// File: /api/mqtt-proxy.js
import mqtt from 'mqtt';

// These environment variables MUST be set in your Vercel project settings.
// This makes the proxy more secure and reusable.
const MQTT_BROKER_HOST = process.env.MQTT_BROKER_HOST || 'io.adafruit.com';
const MQTT_BROKER_PORT = process.env.MQTT_BROKER_PORT || '8883'; // Secure MQTT port
const ADAFRUIT_IO_USERNAME = process.env.ADAFRUIT_IO_USERNAME;
const ADAFRUIT_IO_KEY = process.env.ADAFRUIT_IO_KEY;

// Topic configuration is now kept securely on the server.
const TOPIC_CONTROL = `${ADAFRUIT_IO_USERNAME}/feeds/motor_control`;
const TOPIC_STATUS = `${ADAFRUIT_IO_USERNAME}/feeds/esp32_status`;


/**
 * Main handler for all incoming requests.
 */
export default async function handler(request, response) {
    // 1. Basic validation
    if (request.method !== 'POST') {
        return response.status(405).json({ status: 'error', details: 'Method Not Allowed' });
    }
    if (!ADAFRUIT_IO_USERNAME || !ADAFRUIT_IO_KEY) {
        return response.status(500).json({ status: 'error', details: 'MQTT credentials are not configured on the server.' });
    }

    const { action, payload } = request.body;

    // 2. Route request based on the new, more abstract "action" field
    try {
        if (action === 'send_motor_command') {
            await handlePublish(TOPIC_CONTROL, payload);
            return response.status(200).json({ status: 'success', details: 'Command published.' });

        } else if (action === 'get_device_status') {
            const data = await handleGetStatus(TOPIC_STATUS);
            if (data) {
                return response.status(200).json({ status: 'success', data });
            } else {
                // This indicates the device has likely never published a status or is offline.
                return response.status(404).json({ status: 'error', details: 'Status not found. Device may be offline or has not sent data.' });
            }
        } else {
            return response.status(400).json({ status: 'error', details: 'Invalid action specified.' });
        }
    } catch (error) {
        console.error('[PROXY_ERROR]', error.message);
        // Send back the specific error message for better client-side debugging.
        return response.status(500).json({ status: 'error', details: error.message });
    }
}

/**
 * Publishes a message to an MQTT topic.
 * Connects, publishes, and immediately disconnects. This is a deliberate choice for
 * stateless serverless environments, prioritizing reliability over connection efficiency.
 */
function handlePublish(topic, payload) {
    return new Promise((resolve, reject) => {
        const client = mqtt.connect(`mqtts://${MQTT_BROKER_HOST}:${MQTT_BROKER_PORT}`, {
            username: ADAFRUIT_IO_USERNAME,
            password: ADAFRUIT_IO_KEY,
            clientId: `vercel_proxy_pub_${Date.now()}`, // Unique client ID for publishing
            reconnectPeriod: 0, // Don't attempt to reconnect in this stateless context
        });

        client.on('connect', () => {
            // Include the new `esp_power_on` flag with every command.
            const messagePayload = JSON.stringify({
                command: payload,
                esp_power_on: true // Signal that the dashboard is active
            });
            client.publish(topic, messagePayload, { retain: false }, (err) => {
                client.end(); // Disconnect immediately after publishing.
                if (err) {
                    console.error('[MQTT_PUBLISH_ERROR]', err);
                    return reject(new Error('Failed to publish message.'));
                }
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
 * Fetches the last value of a feed using the Adafruit IO REST API.
 * This is the most reliable method for getting state in a serverless environment.
 */
async function handleGetStatus(topic) {
    const feedKey = topic.split('/').pop();
    const apiUrl = `https://io.adafruit.com/api/v2/${ADAFRUIT_IO_USERNAME}/feeds/${feedKey}/data/last`;

    const apiResponse = await fetch(apiUrl, {
        headers: { 'X-AIO-Key': ADAFRUIT_IO_KEY },
    });

    if (!apiResponse.ok) {
        // This is a common case if the feed has never received data.
        if (apiResponse.status === 404) return null;
        throw new Error(`Adafruit API request failed with status ${apiResponse.status}`);
    }

    const data = await apiResponse.json();
    if (!data || !data.value) {
        return null;
    }

    // Improved Error Handling: Safely parse the JSON payload from the device.
    try {
        // The ESP32 sends the status as a JSON string, so we must parse it here.
        return JSON.parse(data.value);
    } catch (e) {
        console.error('[JSON_PARSE_ERROR]', 'Failed to parse device status:', data.value);
        throw new Error('Received malformed status data from the device.');
    }
}
