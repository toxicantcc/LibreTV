/**
 * 代理请求鉴权模块
 * 为代理请求添加基于 PASSWORD 的鉴权机制
 */

// 从全局配置获取密码哈希（如果存在）
let cachedPasswordHash = null;

/**
 * 同步获取可用的密码哈希（不含需异步 sha256 的 userPassword 分支）
 */
function getPasswordHashSync() {
    if (cachedPasswordHash) {
        return cachedPasswordHash;
    }
    const storedHash = localStorage.getItem('proxyAuthHash');
    if (storedHash) {
        cachedPasswordHash = storedHash;
        return storedHash;
    }
    const passwordVerified = localStorage.getItem('passwordVerified');
    const storedPasswordHash = localStorage.getItem('passwordHash');
    if (passwordVerified === 'true' && storedPasswordHash) {
        localStorage.setItem('proxyAuthHash', storedPasswordHash);
        cachedPasswordHash = storedPasswordHash;
        return storedPasswordHash;
    }
    if (window.__ENV__ && window.__ENV__.PASSWORD) {
        cachedPasswordHash = window.__ENV__.PASSWORD;
        return window.__ENV__.PASSWORD;
    }
    return null;
}

/**
 * 获取当前会话的密码哈希
 */
async function getPasswordHash() {
    const sync = getPasswordHashSync();
    if (sync) {
        return sync;
    }

    // 尝试从用户输入的密码生成哈希（仅异步路径）
    const userPassword = localStorage.getItem('userPassword');
    if (userPassword) {
        try {
            const { sha256 } = await import('./sha256.js');
            const hash = await sha256(userPassword);
            localStorage.setItem('proxyAuthHash', hash);
            cachedPasswordHash = hash;
            return hash;
        } catch (error) {
            console.error('生成密码哈希失败:', error);
        }
    }

    return null;
}

/**
 * 为代理 URL 追加鉴权查询串（同步，供 img onerror 等无法 await 的场景）
 */
function appendProxyAuthQuery(url) {
    const hash = getPasswordHashSync();
    if (!hash) {
        return url;
    }
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}auth=${encodeURIComponent(hash)}&t=${Date.now()}`;
}

/**
 * 为代理请求URL添加鉴权参数
 */
async function addAuthToProxyUrl(url) {
    try {
        const hash = await getPasswordHash();
        if (!hash) {
            console.warn('无法获取密码哈希，代理请求可能失败');
            return url;
        }
        
        // 添加时间戳防止重放攻击
        const timestamp = Date.now();
        
        // 检查URL是否已包含查询参数
        const separator = url.includes('?') ? '&' : '?';
        
        return `${url}${separator}auth=${encodeURIComponent(hash)}&t=${timestamp}`;
    } catch (error) {
        console.error('添加代理鉴权失败:', error);
        return url;
    }
}

/**
 * 验证代理请求的鉴权
 */
function validateProxyAuth(authHash, serverPasswordHash, timestamp) {
    if (!authHash || !serverPasswordHash) {
        return false;
    }
    
    // 验证哈希是否匹配
    if (authHash !== serverPasswordHash) {
        return false;
    }
    
    // 验证时间戳（10分钟有效期）
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10分钟
    
    if (timestamp && (now - parseInt(timestamp)) > maxAge) {
        console.warn('代理请求时间戳过期');
        return false;
    }
    
    return true;
}

/**
 * 清除缓存的鉴权信息
 */
function clearAuthCache() {
    cachedPasswordHash = null;
    localStorage.removeItem('proxyAuthHash');
}

// 监听密码变化，清除缓存
window.addEventListener('storage', (e) => {
    if (e.key === 'userPassword' || (window.PASSWORD_CONFIG && e.key === window.PASSWORD_CONFIG.localStorageKey)) {
        clearAuthCache();
    }
});

// 导出函数
window.ProxyAuth = {
    addAuthToProxyUrl,
    appendProxyAuthQuery,
    validateProxyAuth,
    clearAuthCache,
    getPasswordHash
};
