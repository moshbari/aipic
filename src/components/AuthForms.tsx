'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';

export function AuthForms() {
  const router = useRouter();
  const [isLogin, setIsLogin] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    name: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      if (isLogin) {
        const result = await signIn('credentials', {
          email: formData.email,
          password: formData.password,
          redirect: false,
        });

        if (result?.error) {
          alert('Invalid credentials');
          return;
        }

        router.push('/dashboard');
      } else {
        const response = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData),
        });

        if (!response.ok) {
          const error = await response.json();
          alert(`Error: ${error.error}`);
          return;
        }

        const result = await signIn('credentials', {
          email: formData.email,
          password: formData.password,
          redirect: false,
        });

        if (!result?.error) {
          router.push('/dashboard');
        }
      }
    } catch (error) {
      console.error('Auth error:', error);
      alert('Authentication failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-surface border border-champagne rounded-2xl shadow-2xl p-8">
          <h1 className="text-4xl font-bold text-center mb-2 text-bone tracking-wide">
            <span className="text-champagne">◆</span> AIPic
          </h1>
          <p className="text-center text-taupe mb-8">
            Batch AI Image Generator
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-bone-muted font-medium mb-2">
                Email
              </label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) =>
                  setFormData({ ...formData, email: e.target.value })
                }
                placeholder="your@email.com"
                className="w-full bg-surface-2 border border-champagne rounded-lg px-4 py-2 text-bone placeholder-taupe focus:outline-none focus:ring-2 focus:ring-champagne"
              />
            </div>

            {!isLogin && (
              <div>
                <label className="block text-bone-muted font-medium mb-2">
                  Name
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                  placeholder="Your Name"
                  className="w-full bg-surface-2 border border-champagne rounded-lg px-4 py-2 text-bone placeholder-taupe focus:outline-none focus:ring-2 focus:ring-champagne"
                />
              </div>
            )}

            <div>
              <label className="block text-bone-muted font-medium mb-2">
                Password
              </label>
              <input
                type="password"
                value={formData.password}
                onChange={(e) =>
                  setFormData({ ...formData, password: e.target.value })
                }
                placeholder="••••••••"
                className="w-full bg-surface-2 border border-champagne rounded-lg px-4 py-2 text-bone placeholder-taupe focus:outline-none focus:ring-2 focus:ring-champagne"
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full bg-champagne hover:bg-champagne-hi text-canvas disabled:opacity-50 text-bone font-bold py-3 px-6 rounded-lg transition duration-200 mt-6"
            >
              {isLoading ? 'Loading...' : isLogin ? 'Sign In' : 'Sign Up'}
            </button>
          </form>

          <div className="mt-6">
            <button
              type="button"
              onClick={() => setIsLogin(!isLogin)}
              className="w-full text-taupe hover:text-bone transition"
            >
              {isLogin
                ? "Don't have an account? Sign up"
                : 'Already have an account? Sign in'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
