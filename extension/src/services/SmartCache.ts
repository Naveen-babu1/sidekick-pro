// src/services/SmartCache.ts
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs/promises';

interface CacheEntry {
    key: string;
    response: any;
    timestamp: number;
    hits: number;
    contextHash: string;
    ttl: number;
    metadata: {
        feature: string;
        language: string;
        modelUsed?: string;
    };
}

interface PatternCache {
    pattern: string;
    response: any;
    confidence: number;
    usageCount: number;
}

export class SmartCache {
    private static instance: SmartCache;
    private memoryCache: Map<string, CacheEntry> = new Map();
    private patternCache: Map<string, PatternCache> = new Map();
    private persistentCachePath!: string;
    
    // Cache configuration
    private readonly DEFAULT_TTL = 60000; // 1 minute for normal cache
    private readonly PATTERN_TTL = 300000; // 5 minutes for pattern cache
    private readonly MAX_MEMORY_ENTRIES = 1000;
    private readonly MAX_PATTERN_ENTRIES = 500;
    
    // Quick patterns that get instant responses
    private readonly QUICK_PATTERNS = [
        { pattern: /^if\s*\($/, response: 'condition) {' },
        { pattern: /^for\s*\($/, response: 'let i = 0; i < array.length; i++) {' },
        { pattern: /^while\s*\($/, response: 'condition) {' },
        { pattern: /^function\s+\w+\($/, response: ') {' },
        { pattern: /^class\s+\w+\s*$/, response: '{' },
        { pattern: /^import\s+{$/, response: ' } from "";' },
        { pattern: /^const\s+\w+\s*=$/, response: ' ' },
        { pattern: /^console\.$/, response: 'log();' },
        { pattern: /^return\s+$/, response: '' },
        { pattern: /^\}\s*else\s*$/, response: '{' }
    ];
    
    private constructor() {
        this.initializePersistentCache();
        this.setupCacheCleanup();
    }
    
    static getInstance(): SmartCache {
        if (!this.instance) {
            this.instance = new SmartCache();
        }
        return this.instance;
    }
    
    /**
     * Initialize persistent cache directory
     */
    private async initializePersistentCache() {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            this.persistentCachePath = path.join(
                workspaceFolder.uri.fsPath,
                '.vscode',
                'sidekick-cache'
            );
            
            try {
                await fs.mkdir(this.persistentCachePath, { recursive: true });
                await this.loadPersistentCache();
            } catch (error) {
                console.error('Failed to initialize persistent cache:', error);
            }
        }
    }
    
    /**
     * Get cached response if available
     */
    async get(
        key: string,
        context: any,
        feature: string = 'general'
    ): Promise<any | null> {
        // Check for quick patterns first
        const quickResponse = this.getQuickPattern(key);
        if (quickResponse) {
            return quickResponse;
        }
        
        // Generate context hash for validation
        const contextHash = this.hashContext(context);
        
        // Check memory cache
        const memEntry = this.memoryCache.get(key);
        if (memEntry && this.isValid(memEntry, contextHash)) {
            memEntry.hits++;
            return memEntry.response;
        }
        
        // Check pattern cache
        const patternResponse = this.getPatternMatch(key, context);
        if (patternResponse) {
            return patternResponse;
        }
        
        // Check persistent cache
        const persistentEntry = await this.getPersistent(key, contextHash);
        if (persistentEntry) {
            // Promote to memory cache
            this.memoryCache.set(key, persistentEntry);
            return persistentEntry.response;
        }
        
        return null;
    }
    
    /**
     * Store response in cache
     */
    async set(
        key: string,
        response: any,
        context: any,
        metadata: {
            feature: string;
            language: string;
            modelUsed?: string;
            ttl?: number;
        }
    ): Promise<void> {
        const entry: CacheEntry = {
            key,
            response,
            timestamp: Date.now(),
            hits: 0,
            contextHash: this.hashContext(context),
            ttl: metadata.ttl || this.DEFAULT_TTL,
            metadata
        };
        
        // Store in memory cache
        this.memoryCache.set(key, entry);
        
        // Learn pattern if response is successful
        this.learnPattern(key, response, context);
        
        // Store in persistent cache if significant
        if (this.isSignificant(entry)) {
            await this.setPersistent(entry);
        }
        
        // Cleanup if needed
        this.enforceMemoryLimit();
    }
    
    /**
     * Check for quick pattern matches
     */
    private getQuickPattern(input: string): string | null {
        for (const { pattern, response } of this.QUICK_PATTERNS) {
            if (pattern.test(input)) {
                return response;
            }
        }
        return null;
    }
    
    /**
     * Find pattern-based matches
     */
    private getPatternMatch(key: string, context: any): any | null {
        let bestMatch: { pattern: PatternCache; similarity: number } | null = null;
        
        for (const [patternKey, pattern] of this.patternCache) {
            const similarity = this.calculateSimilarity(key, patternKey);
            if (similarity > 0.8) {
                if (!bestMatch || similarity > bestMatch.similarity) {
                    bestMatch = { pattern, similarity };
                }
            }
        }
        
        if (bestMatch) {
            bestMatch.pattern.usageCount++;
            return this.adaptResponse(bestMatch.pattern.response, key, context);
        }
        
        return null;
    }
    
    /**
     * Learn from successful completions
     */
    private learnPattern(key: string, response: any, context: any): void {
        const patternKey = this.extractPattern(key);
        
        const existing = this.patternCache.get(patternKey);
        if (existing) {
            existing.usageCount++;
            existing.confidence = Math.min(1, existing.confidence + 0.1);
        } else {
            this.patternCache.set(patternKey, {
                pattern: patternKey,
                response,
                confidence: 0.5,
                usageCount: 1
            });
        }
        
        // Enforce pattern cache limit
        if (this.patternCache.size > this.MAX_PATTERN_ENTRIES) {
            this.cleanupPatternCache();
        }
    }
    
    /**
     * Extract pattern from input
     */
    private extractPattern(input: string): string {
        // Remove specific identifiers to create generic pattern
        return input
            .replace(/\b[A-Z][a-zA-Z0-9]*\b/g, '<CLASS>')
            .replace(/\b[a-z][a-zA-Z0-9]*\b/g, '<VAR>')
            .replace(/["'][^"']*["']/g, '<STRING>')
            .replace(/\d+/g, '<NUM>');
    }
    
    /**
     * Calculate similarity between two strings
     */
    private calculateSimilarity(a: string, b: string): number {
        if (a === b) return 1;
        
        const longer = a.length > b.length ? a : b;
        const shorter = a.length > b.length ? b : a;
        
        if (longer.length === 0) return 0;
        
        const editDistance = this.levenshteinDistance(longer, shorter);
        return (longer.length - editDistance) / longer.length;
    }
    
    /**
     * Levenshtein distance for similarity calculation
     */
    private levenshteinDistance(a: string, b: string): number {
        const matrix: number[][] = [];
        
        for (let i = 0; i <= b.length; i++) {
            matrix[i] = [i];
        }
        
        for (let j = 0; j <= a.length; j++) {
            matrix[0][j] = j;
        }
        
        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }
        
        return matrix[b.length][a.length];
    }
    
    /**
     * Adapt cached response to current context
     */
    private adaptResponse(cachedResponse: any, currentKey: string, context: any): any {
        if (typeof cachedResponse === 'string') {
            // Simple variable name replacement
            const cachedVars = cachedResponse.match(/\b[a-z][a-zA-Z0-9]*\b/g) || [];
            const currentVars = currentKey.match(/\b[a-z][a-zA-Z0-9]*\b/g) || [];
            
            let adapted = cachedResponse;
            for (let i = 0; i < Math.min(cachedVars.length, currentVars.length); i++) {
                adapted = adapted.replace(new RegExp(cachedVars[i], 'g'), currentVars[i]);
            }
            
            return adapted;
        }
        
        return cachedResponse;
    }
    
    /**
     * Check if cache entry is still valid
     */
    private isValid(entry: CacheEntry, contextHash: string): boolean {
        const now = Date.now();
        
        // Check TTL
        if (now - entry.timestamp > entry.ttl) {
            return false;
        }
        
        // Check context hash for exact match
        if (entry.contextHash === contextHash) {
            return true;
        }
        
        // Allow fuzzy match for pattern-learned entries
        if (entry.hits > 5) {
            return true;
        }
        
        return false;
    }
    
    /**
     * Check if entry is significant enough to persist
     */
    private isSignificant(entry: CacheEntry): boolean {
        return entry.hits > 2 || 
               entry.metadata.feature === 'completion' ||
               entry.metadata.feature === 'fix';
    }
    
    /**
     * Hash context for comparison
     */
    private hashContext(context: any): string {
        const normalized = JSON.stringify({
            language: context.language,
            imports: context.imports?.sort(),
            function: context.currentFunction?.name,
            class: context.currentClass?.name
        });
        
        return crypto.createHash('md5').update(normalized).digest('hex');
    }
    
    /**
     * Load persistent cache from disk
     */
    private async loadPersistentCache(): Promise<void> {
        try {
            const cacheFile = path.join(this.persistentCachePath, 'cache.json');
            const data = await fs.readFile(cacheFile, 'utf-8');
            const entries = JSON.parse(data) as CacheEntry[];
            
            // Load recent entries into memory
            const now = Date.now();
            for (const entry of entries) {
                if (now - entry.timestamp < 86400000) { // Last 24 hours
                    this.memoryCache.set(entry.key, entry);
                }
            }
        } catch (error) {
            // Cache doesn't exist yet, that's ok
        }
    }
    
    /**
     * Get from persistent cache
     */
    private async getPersistent(key: string, contextHash: string): Promise<CacheEntry | null> {
        try {
            const cacheFile = path.join(this.persistentCachePath, `${contextHash}.json`);
            const data = await fs.readFile(cacheFile, 'utf-8');
            const entry = JSON.parse(data) as CacheEntry;
            
            if (this.isValid(entry, contextHash)) {
                return entry;
            }
        } catch {
            // Not found in persistent cache
        }
        
        return null;
    }
    
    /**
     * Store in persistent cache
     */
    private async setPersistent(entry: CacheEntry): Promise<void> {
        try {
            const cacheFile = path.join(this.persistentCachePath, `${entry.contextHash}.json`);
            await fs.writeFile(cacheFile, JSON.stringify(entry));
        } catch (error) {
            console.error('Failed to write to persistent cache:', error);
        }
    }
    
    /**
     * Enforce memory limits
     */
    private enforceMemoryLimit(): void {
        if (this.memoryCache.size > this.MAX_MEMORY_ENTRIES) {
            // Remove least recently used entries
            const entries = Array.from(this.memoryCache.entries());
            entries.sort((a, b) => {
                const scoreA = a[1].hits + (Date.now() - a[1].timestamp) / 1000;
                const scoreB = b[1].hits + (Date.now() - b[1].timestamp) / 1000;
                return scoreA - scoreB;
            });
            
            // Remove bottom 20%
            const toRemove = Math.floor(this.MAX_MEMORY_ENTRIES * 0.2);
            for (let i = 0; i < toRemove; i++) {
                this.memoryCache.delete(entries[i][0]);
            }
        }
    }
    
    /**
     * Cleanup pattern cache
     */
    private cleanupPatternCache(): void {
        const patterns = Array.from(this.patternCache.entries());
        patterns.sort((a, b) => {
            const scoreA = a[1].usageCount * a[1].confidence;
            const scoreB = b[1].usageCount * b[1].confidence;
            return scoreA - scoreB;
        });
        
        // Remove bottom 20%
        const toRemove = Math.floor(this.MAX_PATTERN_ENTRIES * 0.2);
        for (let i = 0; i < toRemove; i++) {
            this.patternCache.delete(patterns[i][0]);
        }
    }
    
    /**
     * Setup periodic cache cleanup
     */
    private setupCacheCleanup(): void {
        setInterval(() => {
            const now = Date.now();
            
            // Clean expired entries
            for (const [key, entry] of this.memoryCache.entries()) {
                if (now - entry.timestamp > entry.ttl) {
                    this.memoryCache.delete(key);
                }
            }
            
            // Clean old pattern cache
            for (const [key, pattern] of this.patternCache.entries()) {
                if (pattern.usageCount === 1 && pattern.confidence < 0.6) {
                    this.patternCache.delete(key);
                }
            }
        }, 60000); // Every minute
    }
    
    /**
     * Get cache statistics
     */
    getStatistics(): {
        memoryCacheSize: number;
        patternCacheSize: number;
        hitRate: number;
        totalHits: number;
        totalRequests: number;
    } {
        let totalHits = 0;
        let totalRequests = 0;
        
        for (const entry of this.memoryCache.values()) {
            totalHits += entry.hits;
            totalRequests += entry.hits + 1;
        }
        
        return {
            memoryCacheSize: this.memoryCache.size,
            patternCacheSize: this.patternCache.size,
            hitRate: totalRequests > 0 ? totalHits / totalRequests : 0,
            totalHits,
            totalRequests
        };
    }
    
    /**
     * Clear all caches
     */
    clear(): void {
        this.memoryCache.clear();
        this.patternCache.clear();
    }
    
    /**
     * Clear cache for specific document
     */
    clearDocument(document: vscode.TextDocument): void {
        const docPath = document.uri.fsPath;
        
        for (const [key, entry] of this.memoryCache.entries()) {
            if (key.includes(docPath)) {
                this.memoryCache.delete(key);
            }
        }
    }
}