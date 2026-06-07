import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  getState:      (): Promise<unknown> => ipcRenderer.invoke("get-state"),
  getTrades:     (): Promise<unknown> => ipcRenderer.invoke("get-trades"),
  startBot:      (): Promise<{ success: boolean; reason?: string }> => ipcRenderer.invoke("start-bot"),
  stopBot:       (): Promise<{ success: boolean; reason?: string }> => ipcRenderer.invoke("stop-bot"),
  getBotStatus:  (): Promise<{ running: boolean; pid: number | null }> => ipcRenderer.invoke("get-bot-status"),
  getLogs:       (): Promise<string[]> => ipcRenderer.invoke("get-logs"),
  getPositions:       (): Promise<unknown[]>                    => ipcRenderer.invoke("get-positions"),
  closeAllPositions:  (): Promise<{ success: boolean }>         => ipcRenderer.invoke("close-all-positions"),
});
