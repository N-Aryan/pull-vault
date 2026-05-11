"use client";
import { io, Socket } from "socket.io-client";

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (socket) return socket;
  socket = io({ path: "/api/socket", autoConnect: true });
  return socket;
}
