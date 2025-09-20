"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contextKeeperAPI = exports.api = void 0;
const axios_1 = require("axios");
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
exports.api = axios_1.default.create({
    baseURL: API_URL,
    headers: {
        'Content-Type': 'application/json',
    },
});
exports.contextKeeperAPI = {
    // Queries
    query: async (query, repository, limit = 10) => {
        const { data } = await exports.api.post('/api/query', { query, repository, limit });
        return data;
    },
    queryWithBranches: async (query, repository, branches, limit = 10) => {
        const { data } = await exports.api.post('/api/query', {
            query,
            repository,
            branches: branches && branches.length > 0 ? branches : undefined,
            limit
        });
        return data;
    },
    // Repositories
    getRepositories: async () => {
        const { data } = await exports.api.get('/api/repositories');
        return data;
    },
    getRepositoryBranches: async (repoPath) => {
        const { data } = await exports.api.get(`/api/repositories/${encodeURIComponent(repoPath)}/branches`);
        return data;
    },
    // Stats
    getStats: async () => {
        const { data } = await exports.api.get('/api/stats');
        return data;
    },
    // Health
    getHealth: async () => {
        const { data } = await exports.api.get('/health');
        return data;
    },
    // Ingestion
    startIngestion: async (repoPath) => {
        const { data } = await exports.api.post('/api/ingest/start', { repo_path: repoPath });
        return data;
    },
    startMultiBranchIngestion: async (repoPath, options = {}) => {
        const { data } = await exports.api.post('/api/ingest/multi-branch', {
            repo_path: repoPath,
            ...options
        });
        return data;
    },
    getIngestionStatus: async () => {
        const { data } = await exports.api.get('/api/ingest/status');
        return data;
    },
    // Commit Analysis
    getCommitDetails: async (commitHash) => {
        const { data } = await exports.api.get(`/api/commits/${commitHash}`);
        return data;
    },
    compareCommits: async (commit1, commit2) => {
        const { data } = await exports.api.post('/api/commits/compare', {
            commit_1: commit1,
            commit_2: commit2
        });
        return data;
    },
    // Branch Analysis
    analyzeBranchActivity: async (repository, branches) => {
        const { data } = await exports.api.post('/api/analyze/branches', {
            repository,
            branches
        });
        return data;
    },
};
//# sourceMappingURL=api.js.map