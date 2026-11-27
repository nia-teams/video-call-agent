import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {title: 'Video Call Agent', description: 'A local video call and media automation toolkit for macOS.'};
export default function Layout({children}: {children: React.ReactNode}) {
  // Translation extensions may add theme attributes before React hydrates.
  return <html lang="zh-CN" suppressHydrationWarning><body>{children}</body></html>;
}
