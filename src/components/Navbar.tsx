'use client';

import { signOut, useSession } from 'next-auth/react';
import Link from 'next/link';
import { useState } from 'react';

export function Navbar() {
  const { data: session } = useSession();
  const [showMenu, setShowMenu] = useState(false);

  if (!session) return null;

  return (
    <nav className="bg-slate-900 border-b border-purple-500 sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
        <Link href="/dashboard" className="flex items-center gap-2 font-bold text-xl text-white hover:text-purple-400 transition">
          <span className="text-2xl">✨</span>
          AIPic
        </Link>

        <div className="hidden md:flex items-center gap-6">
          <Link href="/dashboard" className="text-gray-300 hover:text-white transition">
            Generator
          </Link>
          <Link href="/dashboard/gallery" className="text-gray-300 hover:text-white transition">
            Gallery
          </Link>
          <Link href="/dashboard/settings" className="text-gray-300 hover:text-white transition">
            Settings
          </Link>
        </div>

        <div className="flex items-center gap-4">
          <span className="text-gray-300 text-sm">{session.user?.email}</span>
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition"
            >
              Menu
            </button>
            {showMenu && (
              <div className="absolute right-0 mt-2 w-48 bg-slate-800 border border-purple-500 rounded-lg shadow-lg overflow-hidden">
                <Link
                  href="/dashboard"
                  className="block px-4 py-2 text-gray-300 hover:bg-purple-600 transition"
                >
                  Generator
                </Link>
                <Link
                  href="/dashboard/gallery"
                  className="block px-4 py-2 text-gray-300 hover:bg-purple-600 transition"
                >
                  Gallery
                </Link>
                <Link
                  href="/dashboard/settings"
                  className="block px-4 py-2 text-gray-300 hover:bg-purple-600 transition"
                >
                  Settings
                </Link>
                <button
                  onClick={() => signOut()}
                  className="w-full text-left px-4 py-2 text-gray-300 hover:bg-red-600 transition"
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
