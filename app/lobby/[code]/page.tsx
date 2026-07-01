import { LobbyApp } from "@/components/lobby-app";

export default async function LobbyPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <LobbyApp code={code.toUpperCase()} />;
}
