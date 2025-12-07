#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const chokidar = require('chokidar');
const ignore = require('ignore');

// Parse .env file and extract configuration
function parseEnvFile(envPath) {
  const content = fs.readFileSync(envPath, 'utf8');
  const config = {
    token: null,
    gitAuthorName: null,
    gitAuthorEmail: null,
    syncTime: 60, // default 60 minutes
    commitDebounceMs: 3000, // default 3 seconds debounce for commits
    projects: []
  };

  const lines = content.split('\n');
  let currentProject = null;

  // Parse each line of the .env file
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Parse key = value format
    const match = trimmed.match(/^([^=]+?)\s*=\s*(.+)$/);
    if (!match) continue;

    const key = match[1].trim();
    const value = match[2].trim();

    // Map .env keys to config properties
    if (key === 'token') {
      config.token = value;
    } else if (key === 'git_author_name') {
      config.gitAuthorName = value;
    } else if (key === 'git_author_email') {
      config.gitAuthorEmail = value;
    } else if (key === 'sync_time') {
      config.syncTime = parseInt(value, 10) || 60;
    } else if (key === 'commit_debounce_ms') {
      config.commitDebounceMs = parseInt(value, 10) || 3000;
    } else if (key === 'gitlink') {
      // Start a new project entry
      if (currentProject) {
        // Finish previous project if it has both fields
        if (currentProject.gitlink && currentProject.gitlocation) {
          config.projects.push(currentProject);
        }
      }
      currentProject = { gitlink: value, gitlocation: null };
    } else if (key === 'gitlocation') {
      // Complete the current project entry
      if (currentProject) {
        currentProject.gitlocation = value;
      }
    }
  }

  // Add last project if it's complete
  if (currentProject && currentProject.gitlink && currentProject.gitlocation) {
    config.projects.push(currentProject);
  }

  return config;
}

// Get .env file path
function getEnvPath() {
  return process.env.ENV_FILE || path.join(__dirname, '.env');
}

// Execute git command with timeout and output management
async function git(projectPath, args, options = {}) {
  const timeout = options.timeout || 300000; // 5 minutes default timeout
  const timeoutMs = timeout;
  const discardOutput = options.discardOutput !== false; // Default to discarding
  const maxOutputSize = options.maxOutputSize || 1024; // 1KB default for commands that need output
  
  // Extract custom options and preserve spawn options
  const { timeout: _, discardOutput: __, maxOutputSize: ___, env, ...spawnOptions } = options;
  
  return new Promise((resolve, reject) => {
    let resolved = false;
    let stdout = '';
    let stderr = '';
    let stdoutSize = 0;
    let stderrSize = 0;
    
    // Spawn git process
    const child = spawn('git', args, {
      cwd: projectPath,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOptions
    });

    // Handle stdout - either discard or collect with size limit
    if (discardOutput) {
      child.stdout.on('data', () => {
        // Discard all output
      });
    } else {
      child.stdout.on('data', (chunk) => {
        if (stdoutSize < maxOutputSize) {
          stdout += chunk.toString();
          stdoutSize += chunk.length;
        }
      });
    }

    // Collect stderr for error messages (limited size)
    child.stderr.on('data', (chunk) => {
      if (stderrSize < 1024) { // Max 1KB for error messages
        stderr += chunk.toString();
        stderrSize += chunk.length;
      }
    });

    // Handle process startup failures (e.g., git not found)
    child.on('error', (error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      cleanup();
      reject(error);
    });

    // Handle process completion
    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      
      // Capture values before cleanup
      const stdoutResult = stdout.trim();
      const stderrResult = stderr.trim();
      
      cleanup();
      
      if (code !== 0) {
        const message = stderrResult || `Git command failed with code ${code}`;
        reject(new Error(message));
      } else {
        resolve({ stdout: stdoutResult, stderr: stderrResult });
      }
    });

    // Set timeout to kill process if it takes too long
    const timeoutId = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      try {
        child.kill('SIGKILL');
      } catch (e) {
        // Ignore kill errors
      }
      reject(new Error(`Git command timed out after ${timeoutMs}ms: git ${args.join(' ')}`));
    }, timeoutMs);

    // Clean up streams and references
    function cleanup() {
      if (child.stdout) {
        child.stdout.removeAllListeners();
        child.stdout.destroy();
      }
      if (child.stderr) {
        child.stderr.removeAllListeners();
        child.stderr.destroy();
      }
      if (child.stdin) {
        child.stdin.removeAllListeners();
        child.stdin.destroy();
      }
      // Clear string references to help GC
      stdout = null;
      stderr = null;
    }
  });
}

// Fetch GitHub user info from API
async function fetchGitHubUserInfo(token) {
  try {
    const response = await axios.get('https://api.github.com/user', {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    return {
      name: response.data.name || response.data.login,
      email: response.data.email || `${response.data.id}+${response.data.login}@users.noreply.github.com`,
      login: response.data.login
    };
  } catch (error) {
    console.error('Failed to fetch GitHub user info:', error.message);
    return null;
  }
}

// Check if directory is a git repository
async function isGitRepo(projectPath) {
  try {
    await git(projectPath, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

// Initialize git repository if it doesn't exist
async function initializeGitRepo(projectPath, userInfo) {
  const projectName = path.basename(projectPath);
  
  try {
    // Check if already a git repo
    const isRepo = await isGitRepo(projectPath);
    if (isRepo) {
      return true;
    }

    console.log(`[${projectName}] Initializing git repository...`);
    
    // Initialize git repo
    await git(projectPath, ['init']);
    
    // Set git config
    await setGitConfig(projectPath, userInfo);
    
    // Create initial commit if there are files
    const hasChanges = await hasUncommittedChanges(projectPath);
    if (hasChanges) {
      await git(projectPath, ['add', '-A']);
      const timestamp = new Date().toISOString();
      await git(projectPath, ['commit', '-m', `Initial commit ${timestamp}`]);
      console.log(`[${projectName}] ✓ Initialized and committed`);
    } else {
      console.log(`[${projectName}] ✓ Initialized (no files to commit)`);
    }
    
    return true;
  } catch (error) {
    console.error(`[${projectName}] Failed to initialize git repository: ${error.message}`);
    return false;
  }
}

// Get current branch
async function getCurrentBranch(projectPath) {
  try {
    const { stdout } = await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'], {
      discardOutput: false,
      maxOutputSize: 256 // Branch names are short
    });
    return stdout || 'main';
  } catch {
    return 'main';
  }
}

// Load .gitignore patterns for a project
function loadGitignorePatterns(projectPath) {
  const ig = ignore();
  
  // Add default ignores
  ig.add([
    '.git',
    '.git/**',
    'node_modules',
    'node_modules/**'
  ]);

  // Load .gitignore if it exists
  const gitignorePath = path.join(projectPath, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    try {
      const content = fs.readFileSync(gitignorePath, 'utf8');
      ig.add(content);
    } catch (error) {
      console.error(`Failed to read .gitignore: ${error.message}`);
    }
  }

  return ig;
}

// Check if path should be ignored
function shouldIgnorePath(projectPath, filePath, igInstance) {
  const relative = path.relative(projectPath, filePath);
  
  // Ignore if outside project
  if (!relative || relative.startsWith('..')) {
    return true;
  }
  
  // Check against ignore patterns
  return igInstance.ignores(relative);
}

// Check if there are uncommitted changes
async function hasUncommittedChanges(projectPath) {
  try {
    const { stdout } = await git(projectPath, ['status', '--porcelain'], {
      discardOutput: false,
      maxOutputSize: 1024 // Only need to check if empty
    });
    return stdout.length > 0;
  } catch {
    return false;
  }
}

// Check if repository has any commits
async function hasCommits(projectPath) {
  try {
    await git(projectPath, ['rev-parse', '--verify', 'HEAD'], {
      discardOutput: true
    });
    return true;
  } catch {
    return false;
  }
}

// Set or update remote URL with authentication token
async function setRemote(projectPath, gitlink, token) {
  let remoteUrl = gitlink;
  
  // Convert URL to authenticated format
  if (remoteUrl.startsWith('https://')) {
    // Remove existing auth if present, then add token
    remoteUrl = remoteUrl.replace(/https:\/\/[^@]+@/, 'https://');
    remoteUrl = remoteUrl.replace('https://', `https://x-access-token:${token}@`);
  } else if (remoteUrl.startsWith('git@')) {
    // Convert SSH format to HTTPS with token
    remoteUrl = remoteUrl
      .replace('git@github.com:', 'https://github.com/')
      .replace('.git', '')
      .replace('https://', `https://x-access-token:${token}@`) + '.git';
  }

  // Check if remote already exists
  let remoteExists = false;
  try {
    await git(projectPath, ['remote', 'get-url', 'github']);
    remoteExists = true;
  } catch {
    remoteExists = false;
  }

  // Update or add remote
  if (remoteExists) {
    await git(projectPath, ['remote', 'set-url', 'github', remoteUrl]);
  } else {
    await git(projectPath, ['remote', 'add', 'github', remoteUrl]);
  }
}

// Set git user config
async function setGitConfig(projectPath, userInfo) {
  await git(projectPath, ['config', 'user.name', userInfo.name]);
  await git(projectPath, ['config', 'user.email', userInfo.email]);
  await git(projectPath, ['config', 'commit.gpgsign', 'false']);
}

// Commit changes in a project
async function commitChanges(projectPath, userInfo) {
  const projectName = path.basename(projectPath);
  
  try {
    // Check if there are changes
    const hasChanges = await hasUncommittedChanges(projectPath);
    if (!hasChanges) {
      return false;
    }

    // Stage all changes
    await git(projectPath, ['add', '-A']);

    // Check again after staging
    const hasChangesAfterStaging = await hasUncommittedChanges(projectPath);
    if (!hasChangesAfterStaging) {
      return false;
    }

    // Set git config
    await setGitConfig(projectPath, userInfo);

    // Commit
    const timestamp = new Date().toISOString();
    await git(projectPath, ['commit', '-m', `Auto backup ${timestamp}`]);
    console.log(`[${projectName}] ✓ Committed changes`);
    return true;
  } catch (error) {
    console.error(`[${projectName}] Failed to commit: ${error.message}`);
    return false;
  }
}

// Extract repo owner and name from GitHub URL
function parseGitHubUrl(gitlink) {
  // Handle various GitHub URL formats:
  // - https://github.com/owner/repo
  // - https://github.com/owner/repo.git
  // - git@github.com:owner/repo.git
  // - https://x-access-token:token@github.com/owner/repo.git
  let cleaned = gitlink.trim();
  
  // Remove .git suffix if present
  cleaned = cleaned.replace(/\.git$/, '');
  
  // Extract owner/repo from URL
  const patterns = [
    /github\.com[\/:]([^\/]+)\/([^\/\?]+)/,  // Standard format
    /github\.com[\/:]([^\/]+)\/([^\/]+)$/   // Fallback
  ];
  
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match && match[1] && match[2]) {
      return { owner: match[1], repo: match[2] };
    }
  }
  
  return null;
}

// Check if GitHub repo exists and create if it doesn't
async function ensureGitHubRepo(gitlink, token, userInfo) {
  const parsed = parseGitHubUrl(gitlink);
  if (!parsed) {
    console.error(`Failed to parse GitHub URL: ${gitlink}`);
    return { exists: false, canRetry: false };
  }

  const { owner, repo } = parsed;

  try {
    // Check if repo exists
    await axios.get(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    return { exists: true, canRetry: false }; // Repo exists
  } catch (error) {
    if (error.response && error.response.status === 404) {
      // Repo doesn't exist, try to create it
      console.log(`[${repo}] Repository doesn't exist, attempting to create...`);
      
      try {
        // Check if we're creating in user's account or an org
        const isUserRepo = owner === userInfo.login;
        const endpoint = isUserRepo 
          ? 'https://api.github.com/user/repos'
          : `https://api.github.com/orgs/${owner}/repos`;

        await axios.post(endpoint, {
          name: repo,
          private: true,
          auto_init: false,
          description: `Auto-synced repository managed by RepoPush`
        }, {
          headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        });
        
        console.log(`[${repo}] ✓ Created private repository on GitHub`);
        return { exists: true, canRetry: false };
      } catch (createError) {
        // Creation failed - could be permissions or other issues
        const isPermissionError = createError.response && 
          (createError.response.status === 403 || createError.response.status === 401);
        
        if (createError.response) {
          if (isPermissionError) {
            // Permission error - provide helpful info but allow retry
            console.warn(`[${repo}] ⚠ Cannot auto-create repository (missing Administration permission)`);
            console.warn(`[${repo}]   Option 1: Add 'Administration: Read and write' permission to your token`);
            console.warn(`[${repo}]   Option 2: Manually create the repository at: https://github.com/${owner}/${repo}`);
            console.warn(`[${repo}]   Will retry on next sync interval...`);
          } else {
            console.error(`[${repo}] ✗ Failed to create repository: ${createError.response.data.message}`);
          }
        } else {
          console.error(`[${repo}] ✗ Failed to create repository: ${createError.message}`);
        }
        
        // Return canRetry=true so we keep trying
        return { exists: false, canRetry: true };
      }
    } else {
      // Other error checking repo (network, auth, etc)
      console.error(`[${repo}] Failed to check repository: ${error.message}`);
      return { exists: false, canRetry: true };
    }
  }
}

// Push changes to GitHub
async function pushToGitHub(projectPath, gitlink, token, userInfo) {
  const projectName = path.basename(projectPath);
  
  try {
    // Ensure GitHub repo exists (create if needed)
    const repoStatus = await ensureGitHubRepo(gitlink, token, userInfo);
    
    if (!repoStatus.exists) {
      if (repoStatus.canRetry) {
        // Repo doesn't exist but we can retry later (e.g., missing permissions or waiting for manual creation)
        console.log(`[${projectName}] Skipping push - will retry on next sync interval`);
      } else {
        // Something is fundamentally wrong (e.g., invalid URL)
        console.error(`[${projectName}] Skipping push - repository configuration error`);
      }
      return false;
    }

    // Check if repo has any commits before pushing
    const hasCommitsInRepo = await hasCommits(projectPath);
    if (!hasCommitsInRepo) {
      console.log(`[${projectName}] Skipping push - no commits in repository yet`);
      return false;
    }

    // Set remote
    await setRemote(projectPath, gitlink, token);

    // Get current branch
    const currentBranch = await getCurrentBranch(projectPath);
    const targetBranch = 'main';

    // Push to GitHub
    console.log(`[${projectName}] Pushing ${currentBranch} -> ${targetBranch} on GitHub...`);
    try {
      await git(projectPath, ['push', '--set-upstream', 'github', `${currentBranch}:${targetBranch}`, '--force'], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: 120000
      });
      console.log(`[${projectName}] ✓ Pushed to GitHub`);
    } catch (error) {
      // Try without set-upstream
      await git(projectPath, ['push', 'github', `${currentBranch}:${targetBranch}`, '--force'], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: 120000
      });
      console.log(`[${projectName}] ✓ Pushed to GitHub`);
    }

    // Push tags
    try {
      await git(projectPath, ['push', 'github', '--tags', '--force'], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: 120000
      });
    } catch (error) {
      // Tags push failure is not critical
    }

    return true;
  } catch (error) {
    console.error(`[${projectName}] Failed to push: ${error.message}`);
    return false;
  }
}

// Manages all projects being watched and synced
class ProjectManager {
  constructor(token, userInfo) {
    this.token = token;
    this.userInfo = userInfo;
    this.projects = new Map(); // path -> { gitlink, watcher, commitTimeout, ignoreInstance }
    this.commitDebounceMs = 3000;
  }

  // Add a project to watch list, initialize git if needed, and optionally commit/push
  async addProject(gitlink, gitlocation, shouldCommitAndPush = true) {
    const projectName = path.basename(gitlocation);

    // Check if directory exists
    if (!fs.existsSync(gitlocation)) {
      console.error(`[${projectName}] ERROR: Directory does not exist: ${gitlocation}`);
      return;
    }

    // Initialize git repo if it doesn't exist
    const wasNewRepo = !(await isGitRepo(gitlocation));
    if (wasNewRepo) {
      const initialized = await initializeGitRepo(gitlocation, this.userInfo);
      if (!initialized) {
        console.error(`[${projectName}] ERROR: Failed to initialize git repository`);
        return;
      }
    }

    // Load .gitignore patterns
    const ignoreInstance = loadGitignorePatterns(gitlocation);

    // Create file watcher
    const watcher = chokidar.watch(gitlocation, {
      persistent: true,
      ignoreInitial: true,
      ignored: [
        /(^|[\/\\])\../, // dot files/folders
        /node_modules/,
        /dist/,
        /build/,
        /logs/,
        /tmp/,
        /cache/,
        /coverage/,
        /\.log$/,
        /\.tmp$/
      ],
      depth: 99,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100
      }
    });

    watcher.on('all', (event, filePath) => {
      this.handleFileChange(gitlocation, filePath, ignoreInstance);
    });

    watcher.on('ready', () => {
      console.log(`[${projectName}] File watcher active`);
    });

    watcher.on('error', error => {
      console.error(`[${projectName}] Watcher error: ${error.message}`);
    });

    this.projects.set(gitlocation, {
      gitlink,
      watcher,
      commitTimeout: null,
      ignoreInstance
    });

    console.log(`[${projectName}] Started watching for changes`);

    // If this is a new project or was just initialized, commit and push immediately
    if (shouldCommitAndPush) {
      // Commit any changes (including initial commit if repo was just created)
      const committed = await commitChanges(gitlocation, this.userInfo);
      if (committed || wasNewRepo) {
        // Push immediately for new repos or if there were changes
        await pushToGitHub(gitlocation, gitlink, this.token, this.userInfo);
      }
    }
  }

  // Handle file change event with debouncing to avoid too many commits
  handleFileChange(projectPath, filePath, ignoreInstance) {
    const projectName = path.basename(projectPath);
    const project = this.projects.get(projectPath);
    
    if (!project) return;

    // Check if file should be ignored
    if (shouldIgnorePath(projectPath, filePath, ignoreInstance)) {
      return;
    }

    // Clear existing timeout to reset debounce timer
    if (project.commitTimeout) {
      clearTimeout(project.commitTimeout);
    }

    // Schedule commit with debounce delay
    project.commitTimeout = setTimeout(async () => {
      project.commitTimeout = null;
      const relativePath = path.relative(projectPath, filePath);
      console.log(`\n[${projectName}] Change detected: ${relativePath}`);
      await commitChanges(projectPath, this.userInfo);
    }, this.commitDebounceMs);
  }

  // Push all projects to GitHub (called on interval)
  async pushAllProjects() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Pushing all projects to GitHub...`);
    console.log(`${'='.repeat(60)}`);

    for (const [projectPath, project] of this.projects) {
      await pushToGitHub(projectPath, project.gitlink, this.token, this.userInfo);
    }

    console.log(`${'='.repeat(60)}`);
    console.log('Push complete');
    console.log(`${'='.repeat(60)}\n`);
  }

  // Update commit debounce delay
  setCommitDebounce(ms) {
    this.commitDebounceMs = ms;
  }

  // Remove project from watch list and cleanup resources
  async removeProject(gitlocation) {
    const project = this.projects.get(gitlocation);
    if (!project) return;

    const projectName = path.basename(gitlocation);
    console.log(`[${projectName}] Removing project from watch list`);

    if (project.commitTimeout) {
      clearTimeout(project.commitTimeout);
    }
    if (project.watcher) {
      await project.watcher.close();
    }

    this.projects.delete(gitlocation);
  }

  // Reload projects from new config (hot-reload support)
  async reloadProjects(newProjects, newToken, newUserInfo, newCommitDebounceMs, newSyncTime) {
    // Update token and user info if changed
    if (newToken !== this.token) {
      this.token = newToken;
    }
    if (newUserInfo && (newUserInfo.name !== this.userInfo.name || newUserInfo.email !== this.userInfo.email)) {
      this.userInfo = newUserInfo;
    }
    if (newCommitDebounceMs !== this.commitDebounceMs) {
      this.setCommitDebounce(newCommitDebounceMs);
    }

    // Create a map of new projects by gitlocation for easy lookup
    const newProjectsMap = new Map();
    for (const project of newProjects) {
      newProjectsMap.set(project.gitlocation, project);
    }

    // Remove projects that are no longer in the config
    const projectsToRemove = [];
    for (const [gitlocation, _] of this.projects) {
      if (!newProjectsMap.has(gitlocation)) {
        projectsToRemove.push(gitlocation);
      }
    }

    for (const gitlocation of projectsToRemove) {
      await this.removeProject(gitlocation);
    }

    // Add new projects that weren't there before
    for (const project of newProjects) {
      if (!this.projects.has(project.gitlocation)) {
        // Commit and push immediately when adding via hot-reload
        await this.addProject(project.gitlink, project.gitlocation, true);
      }
    }

    return newSyncTime;
  }

  // Cleanup all watchers and timeouts on shutdown
  async close() {
    for (const [_, project] of this.projects) {
      if (project.commitTimeout) {
        clearTimeout(project.commitTimeout);
      }
      if (project.watcher) {
        await project.watcher.close();
      }
    }
  }
}

// Main entry point - initializes and starts the application
async function main() {
  console.log('=== RepoPush Enhanced ===');
  console.log('Auto-commit on file changes + Timed GitHub sync\n');

  // Get .env file path
  const envPath = getEnvPath();
  
  if (!fs.existsSync(envPath)) {
    console.error(`ERROR: .env file not found at ${envPath}`);
    process.exit(1);
  }

  // Parse configuration from .env file
  const config = parseEnvFile(envPath);

  if (!config.token) {
    console.error('ERROR: GitHub token not found in .env file');
    process.exit(1);
  }

  if (config.projects.length === 0) {
    console.log('No projects configured in .env file');
    process.exit(1);
  }

  // Get user info from .env or fetch from GitHub
  let userInfo;
  
  // Always fetch login from GitHub API (needed for repo creation logic)
  console.log('Fetching GitHub user information...');
  const githubUserInfo = await fetchGitHubUserInfo(config.token);
  
  if (!githubUserInfo) {
    console.error('ERROR: Failed to fetch GitHub user information');
    process.exit(1);
  }

  if (config.gitAuthorName && config.gitAuthorEmail) {
    // Use credentials from .env but keep login from GitHub API
    console.log('Using git credentials from .env...');
    userInfo = {
      name: config.gitAuthorName,
      email: config.gitAuthorEmail,
      login: githubUserInfo.login // Use actual login from GitHub API
    };
  } else {
    // Use everything from GitHub API
    userInfo = githubUserInfo;
  }

  console.log(`Git Author: ${userInfo.name}`);
  console.log(`Commit Email: ${userInfo.email}`);
  console.log(`Projects to watch: ${config.projects.length}`);
  console.log(`Commit debounce: ${config.commitDebounceMs}ms`);
  console.log(`Push interval: ${config.syncTime} minutes\n`);

  // Create project manager
  const manager = new ProjectManager(config.token, userInfo);
  manager.setCommitDebounce(config.commitDebounceMs);

  // Add all projects (will commit and push immediately if new)
  for (const project of config.projects) {
    await manager.addProject(project.gitlink, project.gitlocation, true);
  }

  console.log('\n✓ All projects initialized');
  console.log('Monitoring for file changes and will push to GitHub every', config.syncTime, 'minutes');
  console.log('Press Ctrl+C to stop\n');

  // Schedule periodic pushes to GitHub
  let syncIntervalMs = config.syncTime * 60 * 1000;
  let intervalId = setInterval(async () => {
    await manager.pushAllProjects();
  }, syncIntervalMs);

  // Watch .env file for configuration changes (hot-reload)
  const envWatcher = chokidar.watch(envPath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 1000,
      pollInterval: 100
    }
  });

  // Handle .env file changes
  envWatcher.on('change', async () => {
    console.log('\n[Config] .env file changed, reloading configuration...');
    
    try {
      // Re-parse .env file
      const newConfig = parseEnvFile(envPath);

      if (!newConfig.token) {
        console.error('[Config] ERROR: GitHub token not found in .env file, keeping current config');
        return;
      }

      // Get user info (reuse existing logic)
      const githubUserInfo = await fetchGitHubUserInfo(newConfig.token);
      if (!githubUserInfo) {
        console.error('[Config] ERROR: Failed to fetch GitHub user information, keeping current config');
        return;
      }

      let newUserInfo;
      if (newConfig.gitAuthorName && newConfig.gitAuthorEmail) {
        newUserInfo = {
          name: newConfig.gitAuthorName,
          email: newConfig.gitAuthorEmail,
          login: githubUserInfo.login // Use actual login from GitHub API
        };
      } else {
        newUserInfo = githubUserInfo;
      }

      // Reload projects
      const newSyncTime = await manager.reloadProjects(
        newConfig.projects,
        newConfig.token,
        newUserInfo,
        newConfig.commitDebounceMs,
        newConfig.syncTime
      );

      // Update sync interval if it changed
      if (newSyncTime !== config.syncTime) {
        console.log(`[Config] Sync interval changed from ${config.syncTime} to ${newSyncTime} minutes`);
        clearInterval(intervalId);
        syncIntervalMs = newSyncTime * 60 * 1000;
        intervalId = setInterval(async () => {
          await manager.pushAllProjects();
        }, syncIntervalMs);
        config.syncTime = newSyncTime;
      }

      console.log(`[Config] Configuration reloaded: ${newConfig.projects.length} project(s) configured`);
      console.log(`[Config] Commit debounce: ${newConfig.commitDebounceMs}ms`);
      console.log(`[Config] Push interval: ${newConfig.syncTime} minutes\n`);
    } catch (error) {
      console.error(`[Config] ERROR: Failed to reload configuration: ${error.message}`);
      console.error('[Config] Keeping current configuration\n');
    }
  });

  envWatcher.on('error', error => {
    console.error(`[Config] Watcher error: ${error.message}`);
  });

  // Perform initial push
  await manager.pushAllProjects();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n\nShutting down...');
    clearInterval(intervalId);
    if (envWatcher) {
      await envWatcher.close();
    }
    await manager.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run main
main().catch(error => {
  console.error(`FATAL: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
