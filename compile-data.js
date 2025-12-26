#!/usr/bin/env node
/**
 * Compiles all competitor JSON files into a unified entity graph
 * with bidirectional cross-references
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'competitor_searches');
const OUTPUT_FILE = path.join(__dirname, 'data.js');
const OUTPUT_DIR = path.join(__dirname, 'data');
const INDEX_FILE = path.join(OUTPUT_DIR, 'index.json');
const ENTITIES_DIR = path.join(OUTPUT_DIR, 'entities');
const FINANCIALS_FILE = path.join(__dirname, 'competitor_financials.json');

// Load financial data
function loadFinancials() {
  try {
    if (fs.existsSync(FINANCIALS_FILE)) {
      const data = JSON.parse(fs.readFileSync(FINANCIALS_FILE, 'utf8'));
      console.log(`Loaded financial data for ${Object.keys(data.entities).length} entities`);
      return data.entities;
    }
  } catch (err) {
    console.warn('Warning: Could not load financials file:', err.message);
  }
  return {};
}

// Get financial data for an entity by trying multiple slug variations
function getFinancialData(financials, name, slug) {
  // Try exact slug match first
  if (financials[slug]) return financials[slug];

  // Try normalized name as slug
  const nameSlug = createSlug(name);
  if (financials[nameSlug]) return financials[nameSlug];

  // Try common variations
  const variations = [
    slug.replace(/-+/g, '-'),
    nameSlug.replace(/-inc$/, ''),
    nameSlug.replace(/-corp$/, ''),
    nameSlug.replace(/-llc$/, ''),
  ];

  for (const v of variations) {
    if (financials[v]) return financials[v];
  }

  return null;
}

// Get the latest year's financial data from financials_by_year
function getLatestFinancials(finData) {
  if (!finData || !finData.financials_by_year) return null;

  const years = Object.keys(finData.financials_by_year).sort((a, b) => parseInt(b) - parseInt(a));
  if (years.length === 0) return null;

  const latestYear = years[0];
  const latest = finData.financials_by_year[latestYear];

  return {
    revenue_2024: latest.revenue || null,
    market_cap: latest.market_cap || null,
    revenue_raw: latest.revenue_raw || null,
    market_cap_raw: latest.market_cap_raw || null
  };
}

// Normalize company names for matching
function normalizeCompanyName(name) {
  return name
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\b(inc|corp|corporation|ltd|llc|co|company|technologies|technology|software|systems|holdings|group|plc|nv|sa)\b/gi, '')
    .trim();
}

// Create a slug from company name
function createSlug(name) {
  return normalizeCompanyName(name)
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// Generate slug variations for matching
function getSlugVariations(name) {
  const base = normalizeCompanyName(name);
  const variations = new Set();

  // Base slug
  const baseSlug = base.replace(/\s+/g, '-').replace(/-+/g, '-');
  variations.add(baseSlug);

  // Without common suffixes (both as word and as ending)
  const withoutSuffixes = base
    .replace(/\b(com|net|io|ai)\b/g, '')
    .replace(/(com|net|io|ai)$/g, '')  // Also match at end without word boundary
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  if (withoutSuffixes) variations.add(withoutSuffixes);

  // Just first word for single-word companies
  const firstWord = base.split(/\s+/)[0];
  if (firstWord.length > 3) {
    variations.add(firstWord);
  }

  // Remove "platforms", "holdings", etc.
  const stripped = base
    .replace(/\b(platforms|holdings|international|worldwide|global)\b/g, '')
    .replace(/(platforms|holdings|international|worldwide|global)$/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  if (stripped) variations.add(stripped);

  // Also add without trailing 'com' specifically (common case like amazoncom -> amazon)
  if (baseSlug.endsWith('com')) {
    variations.add(baseSlug.slice(0, -3));
  }

  return Array.from(variations).filter(v => v.length > 0);
}

// Main compilation
function compileData() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  const financials = loadFinancials();

  // Entity maps
  const publicCompanies = new Map(); // ticker -> company data
  const allEntities = new Map(); // slug -> entity data
  const relationships = []; // { source, target, year, notes }
  const slugToTicker = new Map(); // slug variation -> ticker (for matching)

  console.log(`Processing ${files.length} JSON files...`);

  // First pass: Load all public companies
  for (const file of files) {
    const filePath = path.join(DATA_DIR, file);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    const slug = createSlug(data.company);
    const ticker = data.ticker;

    if (!publicCompanies.has(ticker)) {
      const finData = getFinancialData(financials, data.company, slug);
      const latestFin = getLatestFinancials(finData);
      publicCompanies.set(ticker, {
        slug,
        name: data.company,
        ticker,
        isPublic: true,
        entityType: finData?.type || 'company',
        ownership: 'public',
        parentCompany: finData?.parent_company || null,
        parentSlug: finData?.parent_slug || null,
        financials: latestFin,
        financialsByYear: finData?.financials_by_year || null,
        years: {},
        mentionedBy: [],
        competitors: []
      });
    }

    // Add year data
    publicCompanies.get(ticker).years[data.year] = {
      query: data.search_query,
      date: data.search_date,
      context: data.context,
      sources: data.sources || [],
      competitors: data.competitors || []
    };
  }

  // Build slug variations map for public companies
  for (const [ticker, company] of publicCompanies) {
    const variations = getSlugVariations(company.name);
    for (const v of variations) {
      // Don't overwrite if already mapped to a different ticker
      if (!slugToTicker.has(v) || slugToTicker.get(v) === ticker) {
        slugToTicker.set(v, ticker);
      }
    }
    // Also add ticker itself as a variation
    slugToTicker.set(ticker.toLowerCase(), ticker);
  }

  // Add public companies to all entities
  for (const [ticker, company] of publicCompanies) {
    allEntities.set(company.slug, company);
  }

  console.log(`Found ${publicCompanies.size} public companies`);
  console.log(`Built ${slugToTicker.size} slug variations for matching`);

  // Second pass: Extract all competitor entities and relationships
  for (const [ticker, company] of publicCompanies) {
    for (const [year, yearData] of Object.entries(company.years)) {
      for (const competitor of yearData.competitors) {
        const competitorSlug = createSlug(competitor.name);

        // Find if this competitor is a public company using multiple matching strategies
        let competitorEntity = null;

        // Strategy 1: Check slug variations map
        const competitorVariations = getSlugVariations(competitor.name);
        for (const v of competitorVariations) {
          if (slugToTicker.has(v)) {
            competitorEntity = publicCompanies.get(slugToTicker.get(v));
            break;
          }
        }

        // Strategy 2: Direct slug match (fallback)
        if (!competitorEntity) {
          for (const [t, c] of publicCompanies) {
            if (c.slug === competitorSlug) {
              competitorEntity = c;
              break;
            }
          }
        }

        // Strategy 3: Check if financials data has a ticker that matches a public company
        if (!competitorEntity) {
          const finData = getFinancialData(financials, competitor.name, competitorSlug);
          if (finData?.ticker && publicCompanies.has(finData.ticker)) {
            competitorEntity = publicCompanies.get(finData.ticker);
          }
        }

        // If not found, create as non-public entity
        // Note: Even if financials says "public", we only mark as isPublic if we have source files
        // (entities with source files are already in publicCompanies from first pass)
        if (!competitorEntity) {
          if (!allEntities.has(competitorSlug)) {
            const finData = getFinancialData(financials, competitor.name, competitorSlug);
            const entityType = finData?.type || 'unknown';
            const ownership = finData?.ownership || (entityType === 'product' ? null : 'private');
            const latestFin = getLatestFinancials(finData);

            allEntities.set(competitorSlug, {
              slug: competitorSlug,
              name: competitor.name,
              ticker: finData?.ticker || null,
              isPublic: false,  // Only source file companies are truly "public" in our system
              entityType: entityType,
              ownership: ownership,
              parentCompany: finData?.parent_company || null,
              parentSlug: finData?.parent_slug || null,
              financials: latestFin,
              financialsByYear: finData?.financials_by_year || null,
              mentionedBy: [],
              competitors: [],
              notes: {}
            });
          }
          competitorEntity = allEntities.get(competitorSlug);
        }

        // Add relationship
        relationships.push({
          source: company.slug,
          target: competitorEntity.slug,
          year: parseInt(year),
          notes: competitor.notes
        });

        // Track mentions
        if (!competitorEntity.mentionedBy.find(m => m.slug === company.slug && m.year === parseInt(year))) {
          competitorEntity.mentionedBy.push({
            slug: company.slug,
            name: company.name,
            ticker: company.ticker,
            year: parseInt(year),
            notes: competitor.notes
          });
        }

        // Track competitor notes for non-public entities
        if (!competitorEntity.isPublic) {
          if (!competitorEntity.notes[year]) {
            competitorEntity.notes[year] = [];
          }
          competitorEntity.notes[year].push({
            from: company.name,
            note: competitor.notes
          });
        }

        // Add to company's competitor list
        if (!company.competitors.find(c => c.slug === competitorEntity.slug)) {
          company.competitors.push({
            slug: competitorEntity.slug,
            name: competitorEntity.name,
            ticker: competitorEntity.ticker,
            isPublic: competitorEntity.isPublic,
            entityType: competitorEntity.entityType,
            parentSlug: competitorEntity.parentSlug,
            financials: competitorEntity.financials,
            financialsByYear: competitorEntity.financialsByYear
          });
        }
      }
    }
  }

  // Deduplicate: Remove entities that have same ticker as the canonical public company
  const toRemove = [];
  for (const [slug, entity] of allEntities) {
    if (entity.ticker && publicCompanies.has(entity.ticker)) {
      const publicCompany = publicCompanies.get(entity.ticker);
      // If this entity has a different slug than the canonical public company, it's a duplicate
      if (publicCompany.slug !== slug) {
        // Merge mentions into the public company
        for (const mention of entity.mentionedBy || []) {
          if (!publicCompany.mentionedBy.find(m => m.slug === mention.slug && m.year === mention.year)) {
            publicCompany.mentionedBy.push(mention);
          }
        }
        toRemove.push(slug);
      }
    }
  }

  // Also remove entities that are just name variations of public companies (no ticker but name matches)
  for (const [slug, entity] of allEntities) {
    if (!entity.ticker && !toRemove.includes(slug)) {
      // Check if any slug variation matches a public company
      const variations = getSlugVariations(entity.name);
      for (const v of variations) {
        if (slugToTicker.has(v)) {
          const publicCompany = publicCompanies.get(slugToTicker.get(v));
          if (publicCompany && publicCompany.slug !== slug) {
            // Merge mentions
            for (const mention of entity.mentionedBy || []) {
              if (!publicCompany.mentionedBy.find(m => m.slug === mention.slug && m.year === mention.year)) {
                publicCompany.mentionedBy.push(mention);
              }
            }
            toRemove.push(slug);
            break;
          }
        }
      }
    }
  }

  for (const slug of toRemove) {
    allEntities.delete(slug);
  }

  if (toRemove.length > 0) {
    console.log(`Removed ${toRemove.length} duplicate entities`);
  }

  console.log(`Found ${allEntities.size} total entities`);
  console.log(`Found ${relationships.length} relationships`);

  // Build category/industry inference from context
  const industries = inferIndustries(publicCompanies);

  // Count entity types
  let companyCount = 0;
  let productCount = 0;
  let unknownCount = 0;
  let withFinancialsCount = 0;

  for (const entity of allEntities.values()) {
    if (entity.entityType === 'company' || entity.entityType === 'division') {
      companyCount++;
    } else if (entity.entityType === 'product') {
      productCount++;
    } else {
      unknownCount++;
    }
    if (entity.financials && entity.financials.revenue_2024) {
      withFinancialsCount++;
    }
  }

  // Convert to arrays for output
  const entitiesArray = Array.from(allEntities.values()).sort((a, b) => {
    // Public companies first, then by mention count
    if (a.isPublic !== b.isPublic) return a.isPublic ? -1 : 1;
    return b.mentionedBy.length - a.mentionedBy.length;
  });

  const meta = {
    generated: new Date().toISOString(),
    totalEntities: allEntities.size,
    publicCompanies: publicCompanies.size,
    privateEntities: allEntities.size - publicCompanies.size,
    companies: companyCount,
    products: productCount,
    unknown: unknownCount,
    withFinancials: withFinancialsCount,
    totalRelationships: relationships.length
  };

  // Ensure output directories exist
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!fs.existsSync(ENTITIES_DIR)) fs.mkdirSync(ENTITIES_DIR, { recursive: true });

  // Create lightweight index for fast initial load
  const indexEntities = entitiesArray.map(e => ({
    slug: e.slug,
    name: e.name,
    ticker: e.ticker || null,
    isPublic: e.isPublic,
    entityType: e.entityType,
    parentSlug: e.parentSlug || null,
    mcap: e.financials?.market_cap_raw || 0,
    rev: e.financials?.revenue_raw || 0,
    mentions: e.mentionedBy?.length || 0
  }));

  const indexData = { meta, entities: indexEntities, industries };
  fs.writeFileSync(INDEX_FILE, JSON.stringify(indexData));
  console.log(`\nWritten index to ${INDEX_FILE} (${(fs.statSync(INDEX_FILE).size / 1024).toFixed(1)}KB)`);

  // Create ultra-lightweight public companies index for instant initial load
  const PUBLIC_INDEX_FILE = path.join(OUTPUT_DIR, 'public.json');
  const publicEntities = indexEntities.filter(e => e.isPublic);
  const publicIndexData = { meta, entities: publicEntities, industries };
  fs.writeFileSync(PUBLIC_INDEX_FILE, JSON.stringify(publicIndexData));
  console.log(`Written public index to ${PUBLIC_INDEX_FILE} (${(fs.statSync(PUBLIC_INDEX_FILE).size / 1024).toFixed(1)}KB)`);

  // Write individual entity files
  for (const entity of entitiesArray) {
    const entityFile = path.join(ENTITIES_DIR, `${entity.slug}.json`);
    fs.writeFileSync(entityFile, JSON.stringify(entity));
  }
  console.log(`Written ${entitiesArray.length} entity files to ${ENTITIES_DIR}`);

  // Also write legacy data.js for backwards compatibility
  const output = { meta, entities: entitiesArray, relationships, industries };
  const jsContent = `// Auto-generated competitor data
// Generated: ${output.meta.generated}
const COMPETITOR_DATA = ${JSON.stringify(output, null, 2)};

if (typeof module !== 'undefined') module.exports = COMPETITOR_DATA;
`;

  fs.writeFileSync(OUTPUT_FILE, jsContent);
  console.log(`Written legacy ${OUTPUT_FILE}`);
  console.log(`  - ${meta.publicCompanies} public companies`);
  console.log(`  - ${meta.privateEntities} private/other entities`);
  console.log(`  - ${meta.companies} classified as companies`);
  console.log(`  - ${meta.products} classified as products`);
  console.log(`  - ${meta.withFinancials} with financial data`);
  console.log(`  - ${meta.totalRelationships} relationships`);
}

// Infer industries from company context
function inferIndustries(companies) {
  const industryKeywords = {
    'Cloud & Infrastructure': ['cloud', 'infrastructure', 'iaas', 'paas', 'hosting', 'cdn', 'edge'],
    'Cybersecurity': ['security', 'cybersecurity', 'endpoint', 'firewall', 'threat', 'malware', 'antivirus'],
    'Enterprise Software': ['erp', 'enterprise', 'business software', 'sap', 'oracle'],
    'Data & Analytics': ['data', 'analytics', 'warehouse', 'database', 'bi ', 'business intelligence'],
    'DevOps & Development': ['devops', 'developer', 'git', 'ci/cd', 'code', 'software development'],
    'HR & Payroll': ['payroll', 'hr ', 'human resources', 'hcm', 'workforce'],
    'CRM & Marketing': ['crm', 'marketing', 'customer', 'salesforce', 'hubspot'],
    'Financial Software': ['financial', 'accounting', 'fintech', 'payment', 'billing'],
    'Design & Engineering': ['cad', 'plm', 'simulation', 'design', 'engineering'],
    'Collaboration': ['collaboration', 'communication', 'video', 'meeting', 'document'],
    'AI & Machine Learning': ['ai ', 'artificial intelligence', 'machine learning', 'ml '],
    'Healthcare & Life Sciences': ['healthcare', 'life sciences', 'pharma', 'medical', 'clinical']
  };

  const companyIndustries = {};

  for (const [ticker, company] of companies) {
    const allText = Object.values(company.years)
      .map(y => (y.context || '').toLowerCase())
      .join(' ');

    const industries = [];
    for (const [industry, keywords] of Object.entries(industryKeywords)) {
      if (keywords.some(kw => allText.includes(kw))) {
        industries.push(industry);
      }
    }

    if (industries.length > 0) {
      companyIndustries[company.slug] = industries;
    }
  }

  return companyIndustries;
}

// Run
compileData();
