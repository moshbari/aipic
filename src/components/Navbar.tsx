'use client';

import { signOut, useSession } from 'next-auth/react';
import Link from 'next/link';
import { useState } from 'react';

export function Navbar() {
  const { data: session } = useSession();
  const [showMenu, setShowMenu] = useState(false);

  if (!session) return null;

  return (
    <nav className="bg-canvas border-b border-champagne sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
        <Link href="/dashboard" className="flex items-center gap-2 font-bold text-xl text-bone hover:text-champagne transition">
          <svg className="w-4 h-4 text-champagne" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5L14.5 8 8 14.5 1.5 8z"/></svg>
          <span className="tracking-wide">AIPic</span>
        </Link>

        <div className="hidden md:flex items-center gap-6">
          <Link href="/dashboard" className="text-bone-muted hover:text-bone transition">
            Generator
          </Link>
          <Link href="/dashboard/gallery" className="text-bone-muted hover:text-bone transition">
            Gallery
          </Link>
          <Link href="/dashboard/settings" className="text-bone-muted hover:text-bone transition">
            Settings
          </Link>
        </div>

        <div className="flex items-center gap-4">
          <span className="text-bone-muted text-sm">{session.user?.email}</span>
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="px-4 py-2 bg-champagne text-canvas hover:bg-champagne-lo text-bone rounded-lg transition"
            >
              Menu
            </button>
            {showMenu && (
              <div className="absolute right-0 mt-2 w-48 bg-surface border border-champagne rounded-lg shadow-lg overflow-hidden">
                <Link
                  href="/dashboard"
                  className="block px-4 py-2 text-bone-muted hover:bg-champagne text-canvas transition"
                >
                  Generator
                </Link>
                <Link
                  href="/dashboard/gallery"
                  className="block px-4 py-2 text-bone-muted hover:bg-champagne text-canvas transition"
                >
                  Gallery
                </Link>
                <Link
                  href="/dashboard/settings"
                  className="block px-4 py-2 text-bone-muted hover:bg-champagne text-canvas transition"
                >
                  Settings
                </Link>
                <button
                  onClick={() => signOut()}
                  className="w-full text-left px-4 py-2 text-bone-muted hover:bg-danger transition"
                >
                  Sign Out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
