const ws = new WebSocket("wss://pumpportal.fun/api/data");
ws.addEventListener("open", () => {
  console.log("CONNECTED");
  ws.send(JSON.stringify({ method: "subscribeNewToken" }));
});
ws.addEventListener("message", (e) => {
  console.log("MSG:", String(e.data).slice(0, 300));
  ws.close();
});
ws.addEventListener("error", (e) => { console.log("ERROR:", e.message); });
ws.addEventListener("close", (e) => { console.log("CLOSED code=" + e.code); process.exit(0); });
setTimeout(() => { console.log("TIMEOUT — no message in 10s"); process.exit(0); }, 10000);
