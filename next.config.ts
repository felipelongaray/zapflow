import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // O Next.js 16 bloqueia por padrão requisições de dev vindas de origens
  // diferentes de localhost. Liberamos localhost e as faixas de IP privadas
  // mais comuns para conseguir abrir o app pelo celular/outra máquina na rede.
  //
  // DICA: descubra o IP da sua máquina (macOS: `ipconfig getifaddr en0`) e, se
  // ele não casar com os globs abaixo, adicione-o explicitamente (ex:
  // "192.168.15.7").
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "192.168.0.*",
    "192.168.1.*",
    "192.168.15.*",
    "10.0.0.*",
    "10.0.1.*",
  ],
};

export default nextConfig;
