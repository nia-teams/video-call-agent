import nextEnv from '@next/env';
import { loadEnv } from './env.mjs';

// Next reads its legacy env files before this module. Replace every application
// setting and update its initial snapshot so later resets retain .env.
const env = loadEnv();
nextEnv.updateInitialEnv(env);
const nextConfig = {
  distDir: process.env.STUDIO_BUILD === '1' ? '.next-studio' : process.env.STUDIO_DEV === '1' ? '.next-studio-dev' : '.next',
  devIndicators: false,
};
export default nextConfig;
