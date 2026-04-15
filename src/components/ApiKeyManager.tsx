'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';

interface ApiKey {
  id: string;
  provider: string;
  name: string;
  isActive: boolean;
  createdAt: string;
}

export function ApiKeyManager() {
  const { data: session } = useSession();
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [formData, setFormData] = useState({
    provider: 'OPENAI',
    name: '',
    apiKey: '',
  });

  const fetchApiKeys = async () => {
    if (!session?.user?.id) return;

    setIsLoading(true);
    try {
      const response = await fetch('/api/keys');
      if (!response.ok) throw new Error('Failed to fetch API keys');

      const data = await response.json();
      setApiKeys(data);
    } catch (error) {
      console.error('Fetch error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchApiKeys();
  }, [session]);

  const handleAddKey = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name || !formData.apiKey) {
      alert('Please fill in all fields');
      return;
    }

    try {
      const response = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const error = await response.json();
        alert(`Error: ${error.error}`);
        return;
      }

      setFormData({ provider: 'OPENAI', name: '', apiKey: '' });
      setShowAddForm(false);
      fetchApiKeys();
    } catch (error) {
      console.error('Add key error:', error);
      alert('Failed to add API key');
    }
  };

  const handleDeleteKey = async (id: string) => {
    if (!confirm('Are you sure you want to delete this API key?')) return;

    try {
      const response = await fetch(`/api/keys/${id}`, {
        method: 'DELETE',
      });

      if (!response.ok) throw new Error('Failed to delete');

      fetchApiKeys();
    } catch (error) {
      console.error('Delete error:', error);
      alert('Failed to delete API key');
    }
  };

  const handleToggleKey = async (id: string, isActive: boolean) => {
    try {
      const response = await fetch(`/api/keys/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !isActive }),
      });

      if (!response.ok) throw new Error('Failed to toggle');

      fetchApiKeys();
    } catch (error) {
      console.error('Toggle error:', error);
      alert('Failed to toggle API key');
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-gradient-to-br from-slate-800 to-slate-900 rounded-xl border border-purple-500 p-8">
        <h2 className="text-3xl font-bold text-white mb-2">API Keys</h2>
        <p className="text-gray-400">Manage your API keys securely</p>
      </div>

      <button
        onClick={() => setShowAddForm(!showAddForm)}
        className="bg-purple-600 hover:bg-purple-700 text-white font-bold py-2 px-4 rounded-lg transition"
      >
        {showAddForm ? 'Cancel' : 'Add API Key'}
      </button>

      {showAddForm && (
        <div className="bg-slate-800 border border-purple-500 rounded-lg p-6">
          <form onSubmit={handleAddKey} className="space-y-4">
            <div>
              <label className="block text-gray-300 font-medium mb-2">
                Provider
              </label>
              <select
                value={formData.provider}
                onChange={(e) =>
                  setFormData({ ...formData, provider: e.target.value })
                }
                className="w-full bg-slate-700 border border-purple-500 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-purple-600"
              >
                <option value="OPENAI">OpenAI</option>
              </select>
            </div>

            <div>
              <label className="block text-gray-300 font-medium mb-2">
                Key Name
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) =>
                  setFormData({ ...formData, name: e.target.value })
                }
                placeholder="e.g., Production Key"
                className="w-full bg-slate-700 border border-purple-500 rounded-lg px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-600"
              />
            </div>

            <div>
              <label className="block text-gray-300 font-medium mb-2">
                API Key
              </label>
              <input
                type="password"
                value={formData.apiKey}
                onChange={(e) =>
                  setFormData({ ...formData, apiKey: e.target.value })
                }
                placeholder="sk-..."
                className="w-full bg-slate-700 border border-purple-500 rounded-lg px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-600"
              />
            </div>

            <button
              type="submit"
              className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded-lg transition"
            >
              Add Key
            </button>
          </form>
        </div>
      )}

      {isLoading ? (
        <p className="text-gray-300">Loading...</p>
      ) : apiKeys.length === 0 ? (
        <div className="bg-slate-800 border border-purple-500 rounded-lg p-6 text-center">
          <p className="text-gray-400">No API keys yet. Add one to get started!</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {apiKeys.map((key) => (
            <div
              key={key.id}
              className="bg-slate-800 border border-purple-500 rounded-lg p-4"
            >
              <div className="flex justify-between items-start mb-2">
                <div>
                  <p className="font-bold text-white">{key.name}</p>
                  <p className="text-gray-400 text-sm">{key.provider}</p>
                </div>
                <span
                  className={`px-2 py-1 rounded text-xs font-bold ${
                    key.isActive
                      ? 'bg-green-600 text-white'
                      : 'bg-gray-600 text-gray-300'
                  }`}
                >
                  {key.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>

              <p className="text-gray-400 text-xs mb-4">
                Added {new Date(key.createdAt).toLocaleDateString()}
              </p>

              <div className="flex gap-2">
                <button
                  onClick={() => handleToggleKey(key.id, key.isActive)}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-3 rounded text-sm transition"
                >
                  {key.isActive ? 'Disable' : 'Enable'}
                </button>
                <button
                  onClick={() => handleDeleteKey(key.id)}
                  className="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-3 rounded text-sm transition"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
