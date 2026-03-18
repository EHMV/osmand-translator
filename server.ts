import { createServer, IncomingMessage, ServerResponse } from "node:http"

interface TraccarRecord {
  deviceId: string
  timestamp: string
  latitude: string
  longitude: string
  battery: string
  accuracy: string
  rssi: string
  gateway: string
  temperature?: string
  capacity?: string
}

interface DeviceProfile {
  prefix: string
  batteryField: string      // field name in decoded_payload for voltage
  accuracyField: string     // field name in decoded_payload for accuracy/hdop
  extraFields: string[]     // optional fields to forward (temperature, capacity, etc.)
}

const TRACCAR_OSMAND_URL = process.env.TRACCAR_OSMAND_URL || "http://localhost:5055"
const PORT = parseInt(process.env.PORT || "8080", 10)

// DEVICE_PREFIXES: comma-separated list of accepted device ID prefixes
// Devices not matching any prefix are rejected.
const DEVICE_PREFIXES: string[] = (process.env.DEVICE_PREFIXES || "")
  .split(",")
  .map(p => p.trim())
  .filter(Boolean)

// DEVICE_PROFILES: JSON array of device profile overrides for field mapping
// Default: all devices use { batteryField: "battery", accuracyField: "accuracy" }
// Example: [{"prefix":"fwgs-","batteryField":"BatV","accuracyField":"hdop"}]
const DEVICE_PROFILES: DeviceProfile[] = (() => {
  try {
    return JSON.parse(process.env.DEVICE_PROFILES || "[]")
  } catch {
    console.warn("invalid DEVICE_PROFILES JSON, using defaults")
    return []
  }
})()

function getProfile(deviceId: string): DeviceProfile | null {
  // Check specific profiles first (longest prefix match)
  const profile = DEVICE_PROFILES
    .filter(p => deviceId.startsWith(p.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0]
  if (profile) return profile

  // Fall back to prefix-only check with default field mapping
  if (DEVICE_PREFIXES.some(p => deviceId.startsWith(p))) {
    return { prefix: "", batteryField: "battery", accuracyField: "accuracy", extraFields: [] }
  }

  return null
}

function calculateBattery(voltage: number): string {
  const maxVoltage = 4.2
  const minVoltage = 3.0
  let level = Math.round(((voltage - minVoltage) / (maxVoltage - minVoltage)) * 100)
  if (level < 0) level = 0
  if (level > 100) level = 100
  return level.toString()
}

async function handleWebhook(body: string): Promise<void> {
  const payload = JSON.parse(body)
  const deviceId: string = payload.end_device_ids?.device_id
  if (!deviceId) throw new Error("missing device_id")

  const decoded = payload.uplink_message?.decoded_payload
  if (!decoded) throw new Error("missing decoded_payload")

  const profile = getProfile(deviceId)
  if (!profile) throw new Error(`rejected device prefix: ${deviceId}`)

  const record: TraccarRecord = {
    deviceId,
    timestamp: payload.received_at,
    latitude: decoded.latitude,
    longitude: decoded.longitude,
    battery: calculateBattery(decoded[profile.batteryField]),
    accuracy: decoded[profile.accuracyField],
    rssi: payload.uplink_message.rx_metadata?.[0]?.rssi,
    gateway: payload.uplink_message.rx_metadata?.[0]?.gateway_ids?.gateway_id,
  }

  const params = new URLSearchParams({
    id: record.deviceId,
    timestamp: record.timestamp,
    lat: record.latitude,
    lon: record.longitude,
    batt: record.battery,
    accuracy: record.accuracy,
    rssi: record.rssi,
    gateway: record.gateway,
  })

  // Forward extra fields from the decoded payload if configured
  for (const field of profile.extraFields || []) {
    if (decoded[field] != null) params.set(field, String(decoded[field]))
  }

  const url = `${TRACCAR_OSMAND_URL}/?${params.toString()}`
  console.log(`forwarding ${deviceId} -> ${url}`)

  const resp = await fetch(url, { method: "POST" })
  if (!resp.ok) {
    throw new Error(`traccar responded ${resp.status}: ${await resp.text()}`)
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ""
    req.on("data", (chunk) => (data += chunk))
    req.on("end", () => resolve(data))
    req.on("error", reject)
  })
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200)
    res.end("ok")
    return
  }

  if (req.method === "POST") {
    try {
      const body = await readBody(req)
      if (!body) {
        res.writeHead(400)
        res.end("empty body")
        return
      }
      await handleWebhook(body)
      res.writeHead(200)
      res.end("OK")
    } catch (e) {
      console.error("webhook error:", e)
      res.writeHead(500)
      res.end("Internal Server Error")
    }
    return
  }

  res.writeHead(404)
  res.end("not found")
})

server.listen(PORT, () => {
  console.log(`osmand-translator listening on :${PORT}`)
  console.log(`forwarding to: ${TRACCAR_OSMAND_URL}`)
  console.log(`device prefixes: ${DEVICE_PREFIXES.length ? DEVICE_PREFIXES.join(", ") : "(accept all)"}`)
  console.log(`device profiles: ${DEVICE_PROFILES.length}`)
})
