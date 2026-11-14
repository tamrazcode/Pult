import { createFileRoute } from "@tanstack/react-router";
import { ChatColumn } from "../components/chat/ChatColumn";

export const Route = createFileRoute("/chat")({ component: ChatColumn });
