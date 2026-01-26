/**
 * Vercel Serverless Function: 設定管理API
 * 
 * POST /api/settings - 設定を保存（Vercel環境変数に反映）
 * GET /api/settings - 現在の設定を取得
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

// 設定項目の定義
const SECRET_KEYS = [
  'X_USERNAME',
  'X_PASSWORD', 
  'X_API_KEY',
  'X_API_SECRET',
  'X_ACCESS_TOKEN',
  'X_ACCESS_SECRET',
  'X_BEARER_TOKEN',
  'OPENAI_API_KEY',
  'GROK_API_KEY',
  'GOOGLE_AI_API_KEY',
];

// Vercel API設定
const VERCEL_API_URL = 'https://api.vercel.com';

interface VercelEnvVar {
  id?: string;
  key: string;
  value: string;
  type: 'encrypted' | 'plain' | 'secret';
  target: ('production' | 'preview' | 'development')[];
}

// Vercel APIで環境変数を取得
async function getEnvVars(token: string, projectId: string): Promise<VercelEnvVar[]> {
  const res = await fetch(
    `${VERCEL_API_URL}/v10/projects/${projectId}/env`,
    {
      headers: { Authorization: `Bearer ${token}` }
    }
  );
  
  if (!res.ok) {
    throw new Error(`Failed to get env vars: ${res.status}`);
  }
  
  const data = await res.json();
  return data.envs || [];
}

// Vercel APIで環境変数を作成/更新
async function setEnvVar(
  token: string, 
  projectId: string, 
  key: string, 
  value: string,
  existingId?: string
): Promise<boolean> {
  const body: VercelEnvVar = {
    key,
    value,
    type: 'encrypted',
    target: ['production', 'preview', 'development']
  };
  
  let res: Response;
  
  if (existingId) {
    // 更新
    res = await fetch(
      `${VERCEL_API_URL}/v10/projects/${projectId}/env/${existingId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ value })
      }
    );
  } else {
    // 新規作成
    res = await fetch(
      `${VERCEL_API_URL}/v10/projects/${projectId}/env`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );
  }
  
  return res.ok;
}

// マスク処理
function maskValue(key: string, value: string): string {
  if (!value) return '';
  if (key.includes('PASSWORD') || key.includes('SECRET') || key.includes('KEY') || key.includes('TOKEN')) {
    return value.length > 4 ? '*'.repeat(value.length - 4) + value.slice(-4) : '****';
  }
  return value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // 認証チェック（シンプルなパスワード認証）
  const authPassword = process.env.DASHBOARD_PASSWORD || 'xmarketing2024';
  const providedPassword = req.headers.authorization?.replace('Bearer ', '');
  
  if (providedPassword !== authPassword) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Vercel API認証情報
  const vercelToken = process.env.VERCEL_API_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  
  if (!vercelToken || !projectId) {
    return res.status(500).json({ 
      error: 'Vercel API not configured',
      hint: 'Set VERCEL_API_TOKEN and VERCEL_PROJECT_ID in Vercel environment variables'
    });
  }
  
  try {
    if (req.method === 'GET') {
      // 現在の設定を取得
      const envVars = await getEnvVars(vercelToken, projectId);
      
      const settings: Record<string, { value: string; configured: boolean; id?: string }> = {};
      
      for (const key of SECRET_KEYS) {
        const envVar = envVars.find(e => e.key === key);
        settings[key] = {
          value: envVar ? maskValue(key, envVar.value) : '',
          configured: !!envVar,
          id: envVar?.id
        };
      }
      
      return res.status(200).json({ settings });
    }
    
    if (req.method === 'POST') {
      // 設定を保存
      const newSettings = req.body as Record<string, string>;
      
      // 既存の環境変数を取得
      const envVars = await getEnvVars(vercelToken, projectId);
      
      const results: { key: string; success: boolean }[] = [];
      
      for (const [key, value] of Object.entries(newSettings)) {
        if (!SECRET_KEYS.includes(key)) continue;
        if (!value || value.startsWith('*')) continue; // マスク値はスキップ
        
        const existing = envVars.find(e => e.key === key);
        const success = await setEnvVar(vercelToken, projectId, key, value, existing?.id);
        results.push({ key, success });
      }
      
      const successCount = results.filter(r => r.success).length;
      const failedCount = results.filter(r => !r.success).length;
      
      return res.status(200).json({
        message: '設定を保存しました',
        results: {
          success: successCount,
          failed: failedCount,
          details: results
        },
        note: '変更を反映するには再デプロイが必要です'
      });
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
    
  } catch (error: any) {
    console.error('Settings API error:', error);
    return res.status(500).json({ error: error.message });
  }
}
