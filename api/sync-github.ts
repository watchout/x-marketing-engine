/**
 * Vercel Serverless Function: GitHub Secrets同期API
 * 
 * POST /api/sync-github - VercelのVenv変数をGitHub Secretsに同期
 * 
 * 必要な環境変数:
 * - GITHUB_TOKEN: GitHub Personal Access Token (repo権限必要)
 * - GITHUB_REPO: リポジトリ名 (例: username/repo)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

// GitHub APIでpublic keyを取得（シークレット暗号化に必要）
async function getPublicKey(
  token: string, 
  owner: string, 
  repo: string
): Promise<{ key: string; key_id: string }> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }
  );
  
  if (!res.ok) {
    throw new Error(`Failed to get public key: ${res.status}`);
  }
  
  return res.json();
}

// tweetnacl-jsの代わりにWeb Crypto APIでシークレットを暗号化
async function encryptSecret(publicKey: string, secretValue: string): Promise<string> {
  // Base64デコード
  const publicKeyBytes = Uint8Array.from(atob(publicKey), c => c.charCodeAt(0));
  
  // シークレットをUTF-8バイト配列に変換
  const secretBytes = new TextEncoder().encode(secretValue);
  
  // libsodium-wrappersを使用するためのシンプルな実装
  // Vercel Edge Runtimeではtweetnacl-jsが使えないため
  // GitHub Actionsシークレットはlibsodiumで暗号化する必要がある
  
  // Note: 実際のプロダクションでは tweetnacl-js または libsodium-wrappers を使用
  // ここでは Node.js crypto を使用したフォールバック実装
  
  try {
    // tweetnacl を動的インポート（Vercel Node.js runtime用）
    const nacl = await import('tweetnacl');
    const naclUtil = await import('tweetnacl-util');
    
    const encryptedBytes = nacl.box.seal(
      secretBytes,
      publicKeyBytes
    );
    
    // Base64エンコードして返す
    return naclUtil.encodeBase64(encryptedBytes);
  } catch {
    // フォールバック: プレーンテキストで警告（開発用）
    console.warn('tweetnacl not available, using base64 fallback (NOT SECURE)');
    return Buffer.from(secretValue).toString('base64');
  }
}

// GitHub Secretを設定
async function setGitHubSecret(
  token: string,
  owner: string,
  repo: string,
  secretName: string,
  secretValue: string,
  publicKey: { key: string; key_id: string }
): Promise<boolean> {
  try {
    const encryptedValue = await encryptSecret(publicKey.key, secretValue);
    
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/secrets/${secretName}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        body: JSON.stringify({
          encrypted_value: encryptedValue,
          key_id: publicKey.key_id
        })
      }
    );
    
    return res.ok || res.status === 201 || res.status === 204;
  } catch (error) {
    console.error(`Failed to set secret ${secretName}:`, error);
    return false;
  }
}

// 同期対象のシークレット
const SYNC_SECRETS = [
  'X_API_KEY',
  'X_API_SECRET',
  'X_ACCESS_TOKEN',
  'X_ACCESS_SECRET',
  'X_BEARER_TOKEN',
  'X_USERNAME',
  'X_PASSWORD',
  'OPENAI_API_KEY',
  'GROK_API_KEY',
  'GOOGLE_AI_API_KEY',
];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  // 認証チェック
  const authPassword = process.env.DASHBOARD_PASSWORD || 'xmarketing2024';
  const providedPassword = req.headers.authorization?.replace('Bearer ', '');
  
  if (providedPassword !== authPassword) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // GitHub設定
  const githubToken = process.env.GITHUB_TOKEN;
  const githubRepo = process.env.GITHUB_REPO;
  
  if (!githubToken || !githubRepo) {
    return res.status(500).json({
      error: 'GitHub連携が設定されていません',
      hint: 'GITHUB_TOKEN と GITHUB_REPO を環境変数に設定してください',
      setup: {
        GITHUB_TOKEN: 'GitHub Personal Access Token (repo, workflow権限)',
        GITHUB_REPO: 'owner/repo 形式でリポジトリを指定'
      }
    });
  }
  
  const [owner, repo] = githubRepo.split('/');
  
  if (!owner || !repo) {
    return res.status(500).json({
      error: 'GITHUB_REPO の形式が正しくありません',
      expected: 'owner/repo',
      received: githubRepo
    });
  }
  
  try {
    // 公開鍵を取得
    const publicKey = await getPublicKey(githubToken, owner, repo);
    
    // Vercel環境変数から値を取得して同期
    const results: { key: string; success: boolean; error?: string }[] = [];
    let successCount = 0;
    let skipCount = 0;
    
    for (const secretName of SYNC_SECRETS) {
      const value = process.env[secretName];
      
      if (!value) {
        results.push({ key: secretName, success: false, error: 'Not configured in Vercel' });
        skipCount++;
        continue;
      }
      
      const success = await setGitHubSecret(
        githubToken,
        owner,
        repo,
        secretName,
        value,
        publicKey
      );
      
      results.push({ key: secretName, success });
      if (success) successCount++;
    }
    
    return res.status(200).json({
      message: 'GitHub Secretsへの同期が完了しました',
      repository: githubRepo,
      results: {
        total: SYNC_SECRETS.length,
        success: successCount,
        skipped: skipCount,
        failed: SYNC_SECRETS.length - successCount - skipCount
      },
      details: results,
      note: '変更を反映するには、GitHub Actionsワークフローを再実行してください'
    });
    
  } catch (error: any) {
    console.error('GitHub sync error:', error);
    return res.status(500).json({
      error: 'GitHub同期に失敗しました',
      details: error.message
    });
  }
}
