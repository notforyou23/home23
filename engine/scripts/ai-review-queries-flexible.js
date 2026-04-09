#!/usr/bin/env node

/**
 * AI Review Queries Script (Flexible - Multi-Model)
 * 
 * Generates strategic analysis for selected COSMO queries using:
 * - Claude Sonnet 4.5 (fast, agentic)
 * - Claude Opus 4.5 (most capable)
 * - GPT-5.2 (balanced)
 * 
 * Supports multiple review templates:
 * - Enterprise evaluation
 * - Strategic summary
 * - Technical analysis
 * - Commercial potential
 * - Research insights
 * - Executive brief
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Parse command line arguments
const [,, runDir, runName, configJson] = process.argv;

if (!runDir || !runName || !configJson) {
  console.error('Usage: node ai-review-queries-flexible.js <runDir> <runName> <configJson>');
  process.exit(1);
}

const config = JSON.parse(configJson);
const { model = 'claude-sonnet-4-5', reviewType = 'enterprise', customPrompt = null, timestamps = [] } = config;

// Auto-detect workspace root
const WORKSPACE_ROOT = (() => {
  try {
    const { execSync } = require('child_process');
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  } catch {
    return path.resolve(__dirname, '..');
  }
})();

// AI reviews now live in the run directory (run-isolated, like all COSMO outputs)
const AI_REVIEWS_DIR = path.join(runDir, 'ai-reviews');

// Ensure directory exists
if (!fs.existsSync(AI_REVIEWS_DIR)) {
  fs.mkdirSync(AI_REVIEWS_DIR, { recursive: true });
}

/**
 * Review type prompts - Comprehensive multi-domain analysis templates
 * Each perspective provides unique lens for understanding COSMO outputs
 */
const REVIEW_PROMPTS = {
  
  // ============================================================================
  // BUSINESS & STRATEGY
  // ============================================================================
  
  enterprise: `Given the COSMO output, produce a structured enterprise evaluation report:

**1. Essence / Core Thesis** — one concise sentence

**2. Key Outputs / Concepts** — list 5–10 main ideas with one-line explanations

**3. Novelty / Differentiation** — what makes this non-mainstream or uniquely valuable

**4. Intended Users / Buyers** — who benefits (industries, teams, regulators, investors)

**5. Market Context & Commercial Potential** — opportunity size, comparable solutions, monetization paths

**6. Estimated Value Range** — rough valuation range (USD) if productized

**7. Maturity Level** — conceptual / prototype-ready / pilot-ready / deployable

**8. Strategic Options** — (A) Build company, (B) Sell/license, (C) Integrate, (D) Archive

**9. Risk & Compliance Profile** — regulatory exposure (GDPR, HIPAA, etc.), data-handling concerns

**10. Implementation Dependencies** — stack, data, APIs required; integration friction rating

**11. IP Position & Protectability** — patentability, recommend: File / Trade Secret / Publish

**12. Operational ROI Projection** — 12-month and 36-month ROI bands

**13. Next Ideal COSMO Query** — the single smartest follow-up question

Output format: Markdown. Tone: neutral, analytic, venture-scientist style.`,

  strategic: `Analyze this COSMO output and provide a concise strategic summary:

**What It Is:** One paragraph describing the core concept and deliverables

**Why It Matters:** Key differentiators and unique value propositions

**Who Wants It:** Target audiences, industries, or use cases

**Strategic Actions:** Top 3 recommended next steps (prioritized)

**Follow-Up Query:** One powerful question to push this discovery forward

Keep it brief (1-2 pages), actionable, and executive-friendly.`,

  technical: `Provide a technical analysis of this COSMO output:

**Technical Architecture:**
- Core components and their interactions
- Key algorithms or approaches used
- Data structures and representations

**Implementation Considerations:**
- Stack requirements and dependencies
- Complexity assessment (Low/Medium/High)
- Known technical challenges

**Integration Points:**
- APIs, interfaces, or protocols needed
- Compatibility with existing systems
- Migration or adoption path

**Technical Risks:**
- Performance bottlenecks
- Scalability concerns
- Security or privacy vulnerabilities

**Technical Debt & Maintenance:**
- Long-term maintenance burden
- Documentation requirements
- Testing strategy

Output: Technical but accessible. Include specific recommendations.`,

  engineering: `Evaluate this COSMO output as a software architect/engineering lead:

**SYSTEM ARCHITECTURE:**
- High-level design and components
- Data flow and state management
- API boundaries and contracts
- Architectural patterns used

**TECHNOLOGY STACK:**
- Languages, frameworks, and libraries
- Infrastructure requirements (cloud, on-prem, hybrid)
- Database and storage needs
- Third-party services and dependencies

**SCALABILITY & PERFORMANCE:**
- Expected load and throughput
- Bottlenecks and optimization opportunities
- Caching strategies
- Horizontal vs. vertical scaling

**RELIABILITY & OPERATIONS:**
- Uptime targets and SLAs
- Monitoring and observability
- Incident response and on-call
- Disaster recovery and backups

**SECURITY ARCHITECTURE:**
- Authentication and authorization
- Encryption (at-rest, in-transit)
- Security boundaries and trust zones
- Vulnerability surface area

**DEVELOPMENT PRACTICES:**
- CI/CD pipeline requirements
- Testing strategy (unit, integration, e2e)
- Code review and quality gates
- Release and deployment process

**TECHNICAL DEBT ASSESSMENT:**
- Complexity hot spots
- Refactoring priorities
- Documentation gaps
- Long-term maintainability (0-10 score)

**IMPLEMENTATION PHASES:**
- MVP scope and timeline
- Incremental delivery milestones
- Beta and production readiness criteria

**TEAM REQUIREMENTS:**
- Engineering team composition and size
- Skill sets needed
- External consultants or contractors

**BUILD VS. BUY:**
- What to build in-house
- What to use off-the-shelf
- Integration complexity

Write for an engineering team lead. Be specific, pragmatic, and implementation-focused.`,

  security: `Analyze this COSMO output from a cybersecurity and risk perspective:

**THREAT MODEL:**
- Primary threat actors and motivations
- Attack vectors and entry points
- Assets at risk and criticality
- Threat likelihood and impact matrix

**SECURITY CONTROLS:**
- Authentication mechanisms required
- Authorization and access control model
- Encryption requirements (data, transport, keys)
- Audit logging and forensics

**VULNERABILITY ASSESSMENT:**
- Potential vulnerabilities by category (OWASP Top 10, etc.)
- Supply chain and dependency risks
- Configuration and deployment risks
- Social engineering vectors

**COMPLIANCE & FRAMEWORKS:**
- Applicable security standards (NIST, ISO 27001, SOC 2)
- Industry-specific requirements (PCI-DSS, HIPAA Security Rule)
- Zero Trust Architecture alignment

**INCIDENT RESPONSE:**
- Detection and monitoring requirements
- Response procedures and playbooks
- Communication and disclosure obligations
- Recovery time objectives (RTO/RPO)

**PRIVACY & DATA PROTECTION:**
- PII and sensitive data handling
- Data minimization opportunities
- Anonymization and pseudonymization
- Cross-border data considerations

**SECURITY ARCHITECTURE:**
- Network segmentation
- Defense in depth layers
- Secrets management
- Key management and rotation

**TESTING & VALIDATION:**
- Penetration testing scope
- Security code review priorities
- Red team/purple team exercises
- Bug bounty program considerations

**RISK PRIORITIZATION:**
- Critical risks (address immediately)
- High risks (address in 30 days)
- Medium risks (roadmap items)
- Accepted risks and rationale

**SECURITY BUDGET:**
- Tools and services required
- Security team or consultants
- Estimated annual security spend

Write like a CISO presenting to the board. Be threat-aware but solution-oriented.`,

  commercial: `Evaluate the commercial potential of this COSMO output:

**Market Opportunity:**
- Total addressable market (TAM) estimation
- Target customer segments
- Pain points addressed

**Competitive Landscape:**
- Existing solutions and alternatives
- Competitive advantages
- Barriers to entry

**Business Model:**
- Potential revenue streams
- Pricing strategy options
- Unit economics

**Go-To-Market:**
- Customer acquisition channels
- Partnership opportunities
- Time to market estimate

**Financial Projections:**
- Revenue potential (Year 1, Year 3)
- Cost structure
- Path to profitability

**Investment Thesis:**
- Why this is fundable/acquirable
- Comparable transactions or valuations
- Exit scenarios

Focus on numbers, markets, and money. Be realistic but optimistic where warranted.`,

  research: `Analyze this COSMO output from a research perspective:

**Research Novelty:**
- Novel contributions to the field
- How it advances current understanding
- Potential citations and prior art

**Scientific Merit:**
- Theoretical foundations
- Empirical evidence quality
- Reproducibility and rigor

**Research Directions:**
- Open questions and hypotheses
- Experimental designs to validate
- Adjacent research opportunities

**Publication Potential:**
- Suitable venues (conferences, journals)
- Contribution type (method, system, analysis)
- Required additional work for publication

**Academic Impact:**
- How this could influence the field
- Potential collaborations
- Teaching or curriculum applications

**Next Research Query:**
- Most important research question to explore next

Write for a scientific audience. Be rigorous, cite relevant concepts, suggest experiments.`,

  executive: `Create an executive brief for this COSMO output (max 1 page):

**THE ESSENCE (1-2 sentences):**
What this is and why it matters

**BUSINESS VALUE:**
- Revenue opportunity or cost savings
- Strategic advantage
- Competitive positioning

**INVESTMENT REQUIRED:**
- Estimated development cost
- Time to deployment
- Resource needs

**RISK ASSESSMENT:**
- Key risks (technical, market, regulatory)
- Mitigation strategies

**DECISION REQUIRED:**
☐ Fund & Fast-track
☐ Pilot Program
☐ Further Investigation
☐ Archive for Later

**RECOMMENDED ACTION:**
One clear next step with timeline

Keep it punchy, numbers-focused, and decision-oriented. Think C-suite attention span.`,

  investment: `Evaluate this COSMO output as a VC/investor conducting due diligence:

**INVESTMENT THESIS:**
- Why this is fundable NOW
- What problem/opportunity it captures
- Defensibility and moats

**MARKET ANALYSIS:**
- TAM/SAM/SOM breakdown with numbers
- Market timing and catalysts
- Competitive positioning

**TEAM & EXECUTION:**
- What expertise is needed
- Build vs. buy vs. partner decisions
- Time to product-market fit

**FINANCIAL MODEL:**
- Unit economics
- Customer acquisition cost vs. lifetime value
- Path to $10M, $50M, $100M+ ARR
- Capital requirements by stage

**RISK ASSESSMENT:**
- Technical risk (Low/Med/High)
- Market risk (Low/Med/High)  
- Execution risk (Low/Med/High)
- Mitigations for each

**VALUATION & TERMS:**
- Pre-money valuation range
- Comparable company analysis
- Key terms and protections
- Exit scenarios (timeline, multiples)

**DECISION:**
- PASS / DIG DEEPER / TERM SHEET / PARTNER INTRO
- One specific next action

Write like you're presenting to partners. Be direct, quantitative, and decisive.`,

  // ============================================================================
  // LEGAL & COMPLIANCE
  // ============================================================================

  legal: `Analyze this COSMO output from a legal and compliance perspective:

**LEGAL LANDSCAPE:**
- Applicable laws and regulations (federal, state, international)
- Regulatory bodies and authorities involved
- Compliance frameworks required (SOC2, HIPAA, GDPR, etc.)

**LIABILITY & RISK EXPOSURE:**
- Potential liability vectors (product, professional, IP)
- Contract risk and warranty considerations
- Insurance requirements and coverage gaps

**INTELLECTUAL PROPERTY:**
- Patentability analysis (35 USC §101, §102, §103)
- Trade secret vs. patent strategy
- Copyright and trademark considerations
- Prior art landscape and freedom to operate
- Licensing structure recommendations

**DATA & PRIVACY:**
- Personal data handling (GDPR, CCPA, HIPAA)
- Data retention and deletion policies
- Cross-border data transfer restrictions
- Consent and notice requirements

**CONTRACTUAL FRAMEWORK:**
- Terms of service considerations
- SLA and liability limitations
- Indemnification requirements
- Third-party agreements needed

**REGULATORY APPROVAL PATH:**
- Required certifications or approvals
- Regulatory timeline and milestones
- Submission strategy

**RISK MITIGATION:**
- Legal structuring recommendations
- Insurance and indemnification
- Compliance program requirements

**ACTIONABLE RECOMMENDATIONS:**
- Immediate legal actions required
- Risk-ranked priorities
- Estimated legal budget

Tone: Precise, risk-aware, protective. Flag all material risks clearly.`,

  compliance: `Evaluate this COSMO output for regulatory compliance and governance:

**REGULATORY CLASSIFICATION:**
- What regulations apply (FDA, FTC, SEC, etc.)
- Risk tier/classification (Class I/II/III for medical, etc.)
- Jurisdictional scope

**COMPLIANCE REQUIREMENTS:**
- Mandatory certifications and validations
- Documentation and record-keeping
- Audit trail requirements
- Reporting obligations

**DATA GOVERNANCE:**
- Data classification (PII, PHI, PCI, etc.)
- Access controls and encryption
- Retention and disposal requirements
- Incident response obligations

**QUALITY MANAGEMENT:**
- QMS requirements (ISO 9001, 21 CFR Part 820, etc.)
- Validation and verification protocols
- Change control procedures
- CAPA (Corrective/Preventive Action)

**THIRD-PARTY RISK:**
- Vendor assessment requirements
- BAA (Business Associate Agreement) needs
- Supply chain compliance
- Subprocessor notifications

**COMPLIANCE GAPS:**
- Current state vs. required state
- Priority items for remediation
- Cost and timeline estimates

**ONGOING OBLIGATIONS:**
- Regular reporting cadence
- Renewal/recertification schedule
- Monitoring and surveillance

**IMPLEMENTATION ROADMAP:**
- Pre-launch compliance checklist
- Post-launch monitoring
- Estimated compliance budget

Write for a compliance officer. Be thorough, procedural, and risk-mitigating.`,

  // ============================================================================
  // CREATIVE & DESIGN
  // ============================================================================

  creative: `Analyze this COSMO output from a creative and design perspective:

**CREATIVE CONCEPT:**
- Core creative idea or innovation
- Aesthetic and experiential qualities
- Emotional resonance and appeal

**DESIGN PRINCIPLES:**
- User experience (UX) considerations
- Interface and interaction design
- Visual design and brand expression
- Accessibility and inclusivity

**STORYTELLING & NARRATIVE:**
- Narrative structure and arc
- Story hooks and engagement
- Character, voice, and tone
- Metaphors and mental models

**AUDIENCE ENGAGEMENT:**
- Who this resonates with and why
- Emotional journey and touchpoints
- Memorable moments and "wow" factors
- Shareability and viral potential

**CREATIVE EXECUTION:**
- Medium and format options (video, interactive, print, etc.)
- Production requirements and complexity
- Timeline and creative resources needed

**INNOVATION & ORIGINALITY:**
- What makes this creatively unique
- References and influences (done differently)
- Potential to set new standards or trends

**BRAND & POSITIONING:**
- Brand personality and values expressed
- Market positioning and differentiation
- Cultural fit and relevance

**REFINEMENT OPPORTUNITIES:**
- Areas for creative enhancement
- Simplification or amplification
- Alternative creative directions

**IMPACT & LEGACY:**
- Cultural or artistic significance
- Potential awards or recognition
- Long-term creative influence

Write with creative flair but analytical rigor. Think like a creative director meets design strategist.`,

  marketing: `Evaluate this COSMO output as a marketing strategist:

**POSITIONING & MESSAGING:**
- Core value proposition (one sentence)
- Key messages for each audience segment
- Differentiation from alternatives
- Proof points and credibility builders

**TARGET AUDIENCES:**
- Primary audience (demographics, psychographics, behaviors)
- Secondary audiences and use cases
- Audience pain points addressed
- Jobs-to-be-done framework

**GO-TO-MARKET STRATEGY:**
- Marketing channels (paid, owned, earned)
- Content marketing approach
- Launch sequence and phases
- Budget allocation recommendations

**BRAND STRATEGY:**
- Brand personality and voice
- Visual identity considerations
- Brand story and narrative
- Emotional positioning

**CONTENT STRATEGY:**
- Content types and formats
- Editorial calendar themes
- Thought leadership angles
- SEO and discoverability

**GROWTH TACTICS:**
- Viral/referral mechanics
- Community building approach
- Partnership and co-marketing
- Event and PR strategy

**METRICS & KPIs:**
- North Star metric
- Awareness, consideration, conversion targets
- Customer acquisition cost targets
- Lifetime value projections

**CAMPAIGN IDEAS:**
- 3 high-impact campaign concepts
- Creative angles and hooks
- Channel-specific tactics

**COMPETITIVE RESPONSE:**
- How competitors might react
- Defensive positioning
- Sustaining differentiation

**12-MONTH ROADMAP:**
- Launch phase (months 1-3)
- Growth phase (months 4-9)
- Scale phase (months 10-12)
- Budget and resource requirements

Write persuasively but analytically. Think like a CMO presenting to the board.`,

  // ============================================================================
  // TECHNICAL & ENGINEERING
  // ============================================================================

  technical: `Provide a technical analysis of this COSMO output:

**Technical Architecture:**
- Core components and their interactions
- Key algorithms or approaches used
- Data structures and representations

**Implementation Considerations:**
- Stack requirements and dependencies
- Complexity assessment (Low/Medium/High)
- Known technical challenges

**Integration Points:**
- APIs, interfaces, or protocols needed
- Compatibility with existing systems
- Migration or adoption path

**Technical Risks:**
- Performance bottlenecks
- Scalability concerns
- Security or privacy vulnerabilities

**Technical Debt & Maintenance:**
- Long-term maintenance burden
- Documentation requirements
- Testing strategy

Output: Technical but accessible. Include specific recommendations.`,

  engineering: `Evaluate this COSMO output as a software architect/engineering lead:

**SYSTEM ARCHITECTURE:**
- High-level design and components
- Data flow and state management
- API boundaries and contracts
- Architectural patterns used

**TECHNOLOGY STACK:**
- Languages, frameworks, and libraries
- Infrastructure requirements (cloud, on-prem, hybrid)
- Database and storage needs
- Third-party services and dependencies

**SCALABILITY & PERFORMANCE:**
- Expected load and throughput
- Bottlenecks and optimization opportunities
- Caching strategies
- Horizontal vs. vertical scaling

**RELIABILITY & OPERATIONS:**
- Uptime targets and SLAs
- Monitoring and observability
- Incident response and on-call
- Disaster recovery and backups

**SECURITY ARCHITECTURE:**
- Authentication and authorization
- Encryption (at-rest, in-transit)
- Security boundaries and trust zones
- Vulnerability surface area

**DEVELOPMENT PRACTICES:**
- CI/CD pipeline requirements
- Testing strategy (unit, integration, e2e)
- Code review and quality gates
- Release and deployment process

**TECHNICAL DEBT ASSESSMENT:**
- Complexity hot spots
- Refactoring priorities
- Documentation gaps
- Long-term maintainability (0-10 score)

**IMPLEMENTATION PHASES:**
- MVP scope and timeline
- Incremental delivery milestones
- Beta and production readiness criteria

**TEAM REQUIREMENTS:**
- Engineering team composition and size
- Skill sets needed
- External consultants or contractors

**BUILD VS. BUY:**
- What to build in-house
- What to use off-the-shelf
- Integration complexity

Write for an engineering team lead. Be specific, pragmatic, and implementation-focused.`,

  security: `Analyze this COSMO output from a cybersecurity and risk perspective:

**THREAT MODEL:**
- Primary threat actors and motivations
- Attack vectors and entry points
- Assets at risk and criticality
- Threat likelihood and impact matrix

**SECURITY CONTROLS:**
- Authentication mechanisms required
- Authorization and access control model
- Encryption requirements (data, transport, keys)
- Audit logging and forensics

**VULNERABILITY ASSESSMENT:**
- Potential vulnerabilities by category (OWASP Top 10, etc.)
- Supply chain and dependency risks
- Configuration and deployment risks
- Social engineering vectors

**COMPLIANCE & FRAMEWORKS:**
- Applicable security standards (NIST, ISO 27001, SOC 2)
- Industry-specific requirements (PCI-DSS, HIPAA Security Rule)
- Zero Trust Architecture alignment

**INCIDENT RESPONSE:**
- Detection and monitoring requirements
- Response procedures and playbooks
- Communication and disclosure obligations
- Recovery time objectives (RTO/RPO)

**PRIVACY & DATA PROTECTION:**
- PII and sensitive data handling
- Data minimization opportunities
- Anonymization and pseudonymization
- Cross-border data considerations

**SECURITY ARCHITECTURE:**
- Network segmentation
- Defense in depth layers
- Secrets management
- Key management and rotation

**TESTING & VALIDATION:**
- Penetration testing scope
- Security code review priorities
- Red team/purple team exercises
- Bug bounty program considerations

**RISK PRIORITIZATION:**
- Critical risks (address immediately)
- High risks (address in 30 days)
- Medium risks (roadmap items)
- Accepted risks and rationale

**SECURITY BUDGET:**
- Tools and services required
- Security team or consultants
- Estimated annual security spend

Write like a CISO presenting to the board. Be threat-aware but solution-oriented.`,

  healthcare: `Analyze this COSMO output from a healthcare and clinical perspective:

**CLINICAL UTILITY:**
- Medical use cases and patient populations
- Clinical workflows impacted
- Provider adoption considerations
- Patient outcomes and benefits

**EVIDENCE & VALIDATION:**
- Clinical evidence supporting this approach
- Required validation studies (RCT, observational, etc.)
- Evidence strength and gaps (GRADE framework)
- Real-world evidence opportunities

**REGULATORY PATHWAY:**
- FDA classification (if applicable: device, software, clinical decision support)
- Regulatory strategy (510(k), De Novo, PMA)
- Clinical trial requirements
- Post-market surveillance

**CLINICAL INTEGRATION:**
- EHR integration points and standards (FHIR, HL7)
- Clinical workflow integration
- Physician and staff training requirements
- Interoperability considerations

**SAFETY & QUALITY:**
- Patient safety risks and mitigation
- Clinical risk management (ISO 14971)
- Quality metrics and monitoring
- Adverse event reporting

**HEALTH ECONOMICS:**
- Cost-effectiveness vs. standard of care
- Reimbursement strategy (CPT codes, DRGs)
- Payer coverage and evidence requirements
- Budget impact analysis

**CLINICAL ADOPTION:**
- Barriers to adoption (technical, cultural, workflow)
- Clinical champions and specialty targeting
- Change management requirements
- Success metrics (utilization, outcomes, satisfaction)

**ETHICAL CONSIDERATIONS:**
- Equity and access implications
- Informed consent requirements
- Data privacy in clinical context
- Decision support vs. autonomous decision

**IMPLEMENTATION ROADMAP:**
- Pilot sites and criteria
- Phased rollout strategy
- Clinical validation timeline
- Go-to-market for health systems

Write for a clinical audience (physicians, administrators, QI leaders). Be evidence-based and patient-centered.`,

  education: `Evaluate this COSMO output from an educational and pedagogical perspective:

**LEARNING OBJECTIVES:**
- What learners will know, do, or understand
- Bloom's taxonomy level (remember, understand, apply, analyze, evaluate, create)
- Prerequisite knowledge required

**PEDAGOGICAL APPROACH:**
- Teaching methods and modalities
- Learning theory alignment (constructivism, cognitivism, etc.)
- Active learning and engagement strategies
- Assessment and feedback mechanisms

**CURRICULUM INTEGRATION:**
- Target grade level, course, or program
- Alignment with standards (Common Core, NGSS, etc.)
- Interdisciplinary connections
- Sequence within broader curriculum

**INSTRUCTIONAL DESIGN:**
- Lesson structure and pacing
- Scaffolding and differentiation strategies
- Formative and summative assessments
- Materials and resources needed

**ACCESSIBILITY & INCLUSION:**
- Universal Design for Learning (UDL) alignment
- Accommodations and modifications
- Language and cultural considerations
- Technology access requirements

**STUDENT ENGAGEMENT:**
- Intrinsic motivation factors
- Relevance and real-world connections
- Collaboration and peer learning
- Student choice and agency

**EDUCATIONAL TECHNOLOGY:**
- Tech tools and platforms needed
- Digital literacy requirements
- Online, hybrid, or in-person delivery
- Data privacy (FERPA, COPPA)

**EDUCATOR SUPPORT:**
- Professional development needed
- Implementation guidance and resources
- Community of practice
- Common challenges and solutions

**IMPACT & OUTCOMES:**
- Evidence of learning effectiveness
- Equity in outcomes across demographics
- Transfer to other contexts
- Long-term skill development

**SCALABILITY:**
- Classroom to school to district rollout
- Cost per student
- Sustainability and maintenance

Write for educators and instructional designers. Be learner-centered and evidence-based.`,

  policy: `Analyze this COSMO output from a public policy and governance perspective:

**POLICY CONTEXT:**
- Current policy landscape and gaps
- Political feasibility and stakeholders
- Jurisdiction and authority (federal, state, local, international)

**PUBLIC INTEREST:**
- Social benefits and externalities
- Equity and access implications
- Public safety and welfare considerations
- Environmental and sustainability impact

**STAKEHOLDER ANALYSIS:**
- Who benefits and who bears costs
- Power dynamics and influence
- Coalition building opportunities
- Opposition and resistance points

**POLICY MECHANISMS:**
- Regulatory approach (command-and-control, market-based, voluntary)
- Incentive structures and enforcement
- Funding mechanisms and budget implications
- Interagency coordination needs

**ECONOMIC ANALYSIS:**
- Cost-benefit analysis
- Distributional effects (who wins, who loses)
- Market efficiency and failures addressed
- Economic multipliers and indirect effects

**IMPLEMENTATION:**
- Administrative feasibility
- Required agency capacity and expertise
- Timeline and phase-in approach
- Monitoring and evaluation plan

**POLITICAL STRATEGY:**
- Legislative or executive action path
- Key champions and committees
- Public engagement and comment process
- Messaging and framing for diverse audiences

**UNINTENDED CONSEQUENCES:**
- Potential negative side effects
- Gaming and loopholes
- Displacement and substitution effects
- Monitoring and course correction

**EVIDENCE BASE:**
- Research supporting this approach
- Pilot programs or natural experiments
- Comparable policies in other jurisdictions
- Evidence gaps requiring study

**LONG-TERM SUSTAINABILITY:**
- Political durability across administrations
- Funding sustainability
- Institutional capacity building
- Sunset or renewal provisions

Write for policy makers and analysts. Be non-partisan, evidence-based, and pragmatic.`,

  journalism: `Analyze this COSMO output from a journalistic perspective:

**STORY ANGLE:**
- The lede (first paragraph hook)
- Why this matters NOW (timeliness, relevance)
- Human interest and narrative arc
- Unique or surprising elements

**NEWS VALUE:**
- Impact (how many affected, how deeply)
- Prominence (notable people/organizations)
- Proximity (geographic or emotional relevance)
- Conflict or controversy
- Unusualness or novelty

**SOURCING & VERIFICATION:**
- Key sources to interview (experts, users, critics)
- Documents and data to verify
- Conflicting claims to investigate
- Fact-checking requirements

**MULTIPLE PERSPECTIVES:**
- Proponent viewpoints
- Skeptic or critic perspectives
- Affected communities
- Expert commentary
- Regulatory or authority response

**CONTEXT & BACKGROUND:**
- Historical context and precedents
- Broader trends and patterns
- Technical explainers for lay audience
- "What you need to know" sidebar

**INVESTIGATION LEADS:**
- Unanswered questions requiring reporting
- FOIA requests or public records
- Data analysis opportunities
- Investigative angles (money, power, harm)

**VISUAL STORYTELLING:**
- Photo/video opportunities
- Infographics and data visualization
- Interactive elements
- Multimedia package potential

**ETHICS & STANDARDS:**
- Privacy concerns (naming sources/subjects)
- Potential harms from coverage
- Balance and fairness considerations
- Corrections or updates needed

**AUDIENCE ENGAGEMENT:**
- Reader questions to address
- Social media hooks
- Comment moderation issues
- Follow-up story potential

**PUBLICATION STRATEGY:**
- Story length and depth (news brief, feature, investigation)
- Timing and competitive considerations
- Platform and format (print, web, podcast)
- Promotion and distribution

Write like you're pitching to an editor. Be skeptical, thorough, and public-interest focused.`,

  ethics: `Evaluate this COSMO output from an ethical and philosophical perspective:

**ETHICAL FRAMEWORK:**
- Primary ethical considerations (autonomy, beneficence, justice, non-maleficence)
- Relevant ethical theories (utilitarian, deontological, virtue ethics, care ethics)
- Rights and duties implicated

**STAKEHOLDER IMPACTS:**
- Who benefits and how
- Who bears risks or harms
- Power asymmetries and vulnerable populations
- Procedural justice and participation

**MORAL IMPLICATIONS:**
- Intended vs. unintended consequences
- Short-term vs. long-term effects
- Individual vs. collective good tensions
- Precedents and slippery slopes

**VALUES & TRADE-OFFS:**
- Core values advanced or threatened (privacy, fairness, transparency, safety)
- Unavoidable trade-offs and how to navigate them
- Whose values are embedded in design
- Value pluralism and accommodation

**FAIRNESS & EQUITY:**
- Distributional justice concerns
- Disparate impact across demographics
- Access and inclusion
- Procedural fairness

**AUTONOMY & CONSENT:**
- Informed consent requirements and challenges
- Nudging vs. manipulation
- Freedom of choice preservation
- Opt-in vs. opt-out design

**TRANSPARENCY & ACCOUNTABILITY:**
- Explainability and interpretability needs
- Accountability mechanisms and responsibility
- Audit and oversight structures
- Redress and remedy for harms

**LONG-TERM & SYSTEMIC:**
- Effects on social norms and institutions
- Cumulative and interaction effects
- Future generations and sustainability
- Irreversible changes

**MORAL RISKS:**
- Highest ethical risks identified
- Red lines and non-negotiable constraints
- Moral hazard and perverse incentives

**ETHICAL RECOMMENDATIONS:**
- Mitigation strategies for each major risk
- Design choices that embed ethical values
- Governance and oversight structures
- Ongoing ethical review requirements

**QUESTIONS FOR DELIBERATION:**
- Unresolved ethical tensions
- Questions for stakeholder input
- Areas requiring public dialogue

Write with moral clarity and nuance. Think like an ethicist advising decision-makers.`,

  cultural: `Analyze this COSMO output from cultural and anthropological perspectives:

**CULTURAL CONTEXT:**
- Cultural systems and worldviews engaged
- Historical and social situatedness
- Power structures and hegemonies
- Whose culture is centered vs. marginalized

**SOCIAL DYNAMICS:**
- How this shapes or reflects social practices
- Community and relationship impacts
- Status, identity, and belonging
- Ritual, symbol, and meaning-making

**CULTURAL PRODUCTION:**
- What cultural forms or expressions this enables/constrains
- Creative and expressive possibilities
- Cultural preservation vs. innovation
- Authenticity and appropriation considerations

**LANGUAGE & COMMUNICATION:**
- How language and discourse are shaped
- Narrative and storytelling traditions
- Cross-cultural communication and translation
- Linguistic diversity and dominance

**VALUES & WORLDVIEWS:**
- Cultural values embedded in design
- Assumptions about human nature and society
- Individualist vs. collectivist orientations
- Sacred vs. profane boundaries

**SOCIAL CHANGE:**
- How this accelerates or resists cultural change
- Tradition vs. modernity tensions
- Generational impacts and divides
- Social movements and activism potential

**INEQUALITY & JUSTICE:**
- Cultural capital and access
- Representation and visibility
- Colonialism and extractive patterns
- Decolonization and sovereignty

**CULTURAL ADAPTATION:**
- How different cultures might adopt or resist
- Localization and contextualization needs
- Cultural broker and mediator roles
- Hybrid and syncretic possibilities

**SYMBOLIC & RITUAL:**
- Symbolic meanings and interpretations
- Ritual and ceremonial dimensions
- Taboos and transgressive elements
- Rites of passage and transitions

**LONG-TERM CULTURAL IMPACT:**
- Effects on cultural diversity
- Homogenization vs. pluralism
- Memory, history, and heritage
- Cultural sustainability

Write with cultural humility and critical awareness. Think like a cultural anthropologist.`,

  datascience: `Analyze this COSMO output from a data science and analytics perspective:

**DATA REQUIREMENTS:**
- Data types and sources needed
- Volume, velocity, variety considerations
- Data quality and completeness requirements
- Feature engineering opportunities

**ANALYTICAL METHODS:**
- Statistical techniques applicable
- Machine learning approaches (if relevant)
- Causal inference vs. prediction
- Model interpretability needs

**METRICS & KPIs:**
- Success metrics and targets
- Leading vs. lagging indicators
- Baseline measurements and benchmarks
- Statistical significance and power

**EXPERIMENTAL DESIGN:**
- A/B testing opportunities
- Observational study designs
- Sample size and duration
- Confounding variables and controls

**DATA PIPELINE:**
- ETL processes required
- Real-time vs. batch processing
- Data validation and quality checks
- Monitoring and alerting

**MODELING & ALGORITHMS:**
- Algorithm selection rationale
- Training data requirements
- Validation and testing strategy
- Model drift and retraining

**BIAS & FAIRNESS:**
- Potential sources of bias
- Fairness metrics and constraints
- Disparate impact analysis
- Mitigation strategies

**INFRASTRUCTURE:**
- Computing resources (CPU, GPU, memory)
- Storage requirements
- Scalability and cost optimization
- Tools and platforms (cloud, on-prem)

**VISUALIZATION & REPORTING:**
- Dashboard and reporting needs
- Stakeholder-specific views
- Interactive vs. static visualizations
- Automated reporting cadence

**DATA GOVERNANCE:**
- Data lineage and provenance
- Privacy and security controls
- Retention and archival policies
- Regulatory compliance (GDPR, etc.)

**TEAM & SKILLS:**
- Data science team composition
- Required expertise (stats, ML, engineering)
- Collaboration with domain experts
- Tooling and infrastructure support

Write for a data science team. Be quantitative, methodologically rigorous, and results-focused.`,

  operations: `Evaluate this COSMO output from an operations and logistics perspective:

**OPERATIONAL MODEL:**
- Core operational processes
- Resource requirements (people, equipment, facilities)
- Workflow and process flow
- Standard operating procedures needed

**SUPPLY CHAIN:**
- Suppliers and dependencies
- Procurement and sourcing strategy
- Inventory management
- Logistics and distribution

**CAPACITY PLANNING:**
- Throughput and volume projections
- Bottlenecks and constraints
- Utilization targets
- Expansion and contraction flexibility

**QUALITY & EFFICIENCY:**
- Quality control and assurance
- Process efficiency metrics (cycle time, yield, defects)
- Continuous improvement opportunities
- Lean/Six Sigma applications

**COST STRUCTURE:**
- Fixed vs. variable costs
- Cost drivers and levers
- Economies of scale
- Cost reduction opportunities

**RISK MANAGEMENT:**
- Operational risks and failure modes
- Business continuity and disaster recovery
- Redundancy and backup plans
- Insurance and risk transfer

**VENDOR & PARTNER MANAGEMENT:**
- Key vendors and SLAs
- Contract management
- Performance monitoring
- Relationship management

**PEOPLE & ORGANIZATION:**
- Staffing model and headcount
- Skills and training requirements
- Shift coverage and scheduling
- Organizational structure

**TECHNOLOGY & SYSTEMS:**
- Operational systems and tools
- Automation opportunities
- Integration requirements
- Data and reporting systems

**COMPLIANCE & STANDARDS:**
- Industry standards and best practices
- Certifications required (ISO, etc.)
- Audit and inspection readiness
- Documentation and record-keeping

**IMPLEMENTATION PLAN:**
- Phase 1: Pilot and proof of concept
- Phase 2: Scale and optimize
- Phase 3: Steady state operations
- Timeline and milestones

**METRICS & REPORTING:**
- Operational KPIs
- Reporting cadence and audience
- Dashboard and visibility
- Alert thresholds and escalation

Write for an operations leader. Be process-oriented, efficiency-focused, and pragmatic.`
};

/**
 * Call AI to analyze a query (routes to correct provider)
 */
async function analyzeWithAI(model, query, answer, reviewType, customPrompt) {
  const prompt = customPrompt || REVIEW_PROMPTS[reviewType] || REVIEW_PROMPTS.enterprise;
  
  const fullPrompt = `${prompt}

---

ORIGINAL QUERY:
${query}

COSMO'S RESPONSE:
${answer}`;

  const systemPrompt = 'You are a senior analytical reviewer evaluating outputs from COSMO, an autonomous R&D engine. Your task is to extract the scientific, commercial, and strategic value of each run — and determine the next best question to drive COSMO forward.';

  try {
    if (model.startsWith('claude')) {
      // Use Anthropic Claude (exact IDE pattern)
      const Anthropic = require('@anthropic-ai/sdk');
      const anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
      
      // Determine correct Claude model (December 2025)
      const claudeModel = model === 'claude-opus-4-5' 
        ? 'claude-3-opus-20240229'  // Claude 3 Opus
        : 'claude-sonnet-4-5-20250929';  // Claude Sonnet 4.5 - Latest, most capable
      
      console.log('      Calling Anthropic with model:', claudeModel);
      console.log('      Prompt size:', fullPrompt.length, 'chars');
      
      try {
        const response = await anthropic.messages.create({
          model: claudeModel,
          max_tokens: 16000,
          temperature: 0.1,
          system: systemPrompt,
          messages: [{
            role: 'user',
            content: fullPrompt
          }]
        });
        
        console.log('      Response received from Claude');
        
        // Filter for text blocks only
        const content = response.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n');
        
        return content;
        
      } catch (anthropicError) {
        // Log detailed Anthropic error
        console.error('      ❌ Anthropic API error:', {
          status: anthropicError.status,
          type: anthropicError.type,
          message: anthropicError.message
        });
        throw new Error(`Anthropic API error: ${anthropicError.status} - ${anthropicError.message}`);
      }
      
    } else {
      // Use OpenAI GPT-5.2 (matched to IDE pattern)
      const { getOpenAIClient } = require(path.join(WORKSPACE_ROOT, 'src', 'core', 'openai-client'));
      const openai = getOpenAIClient();
      
      const response = await openai.chat.completions.create({
        model: 'gpt-5.2',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: fullPrompt }
        ],
        temperature: 0.1,
        max_completion_tokens: 16000
      });
      
      return response.choices[0].message.content;
    }
    
  } catch (error) {
    throw new Error(`AI analysis failed: ${error.message}`);
  }
}

/**
 * Check if a review already exists
 * New format: query-{N}-{reviewType}-{model}.md (prevents overwrites, allows multiple perspectives)
 */
function hasExistingReview(queryIndex, reviewType, model) {
  const reviewFile = path.join(AI_REVIEWS_DIR, `query-${queryIndex}-${reviewType}-${model}.md`);
  
  if (!fs.existsSync(reviewFile)) {
    return false;
  }
  
  try {
    const content = fs.readFileSync(reviewFile, 'utf-8');
    // Consider complete if it has substantial content
    return content.length > 500;
  } catch (error) {
    return false;
  }
}

/**
 * Process a single query with AI review
 */
async function processQueryWithAI(model, query, runName, queryIndex, reviewType, customPrompt) {
  console.log(`   🤖 Reviewing query ${queryIndex} with ${model} (${reviewType})...`);
  
  // Check if already reviewed (specific to this model and review type)
  if (hasExistingReview(queryIndex, reviewType, model)) {
    console.log(`      ℹ️  Review already exists for this combination - skipping`);
    return null;
  }
  
  console.log(`      Query: ${query.query.substring(0, 60)}...`);
  console.log(`      Response: ${query.answer.length.toLocaleString()} chars`);
  
  try {
    const analysis = await analyzeWithAI(model, query.query, query.answer, reviewType, customPrompt);
    
    if (!analysis || analysis.length < 500) {
      throw new Error(`Review too short (${analysis?.length || 0} chars)`);
    }
    
    console.log(`      ✅ Generated review (${analysis.length.toLocaleString()} chars)`);
    
    const reviewDoc = [];
    reviewDoc.push(`# AI Review: ${runName} - Query ${queryIndex}`);
    reviewDoc.push('');
    reviewDoc.push(`**Review Type:** ${reviewType}`);
    reviewDoc.push(`**Model:** ${model}`);
    reviewDoc.push(`**Original Query:** ${query.query}`);
    reviewDoc.push(`**Timestamp:** ${new Date(query.timestamp).toLocaleString()}`);
    reviewDoc.push(`**COSMO Model Used:** ${query.model} (${query.mode} mode)`);
    reviewDoc.push('');
    reviewDoc.push('---');
    reviewDoc.push('');
    reviewDoc.push(analysis);
    reviewDoc.push('');
    reviewDoc.push('---');
    reviewDoc.push('');
    reviewDoc.push('## Original Full Response');
    reviewDoc.push('');
    reviewDoc.push('<details>');
    reviewDoc.push('<summary>Click to expand full COSMO response</summary>');
    reviewDoc.push('');
    reviewDoc.push('```');
    reviewDoc.push(query.answer);
    reviewDoc.push('```');
    reviewDoc.push('');
    reviewDoc.push('</details>');
    
    return reviewDoc.join('\n');
    
  } catch (error) {
    console.error(`      ❌ Review failed: ${error.message}`);
    return null;
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║        COSMO AI Query Review (Flexible)               ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Run: ${runName}`);
  console.log(`Model: ${model}`);
  console.log(`Review Type: ${reviewType}`);
  console.log(`Queries: ${timestamps.length}`);
  console.log('');
  
  // Read queries.jsonl from run directory
  const queriesFile = path.join(runDir, 'queries.jsonl');
  
  if (!fs.existsSync(queriesFile)) {
    console.error(`❌ No queries.jsonl found in ${runDir}`);
    process.exit(1);
  }
  
  // Parse queries
  const content = fs.readFileSync(queriesFile, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.length > 0);
  const allQueries = lines.map(line => {
    try {
      return JSON.parse(line);
    } catch (error) {
      return null;
    }
  }).filter(q => q !== null);
  
  console.log(`Total queries in file: ${allQueries.length}`);
  
  // Filter to only requested timestamps
  const selectedQueries = allQueries.filter(q => timestamps.includes(q.timestamp));
  
  console.log(`Selected queries: ${selectedQueries.length}`);
  console.log('');
  console.log('═══════════════════════════════════════════════════════\n');
  
  let processed = 0;
  let skipped = 0;
  
  for (let i = 0; i < selectedQueries.length; i++) {
    const query = selectedQueries[i];
    const queryIndex = allQueries.indexOf(query) + 1;
    
    const review = await processQueryWithAI(model, query, runName, queryIndex, reviewType, customPrompt);
    
    if (review) {
      // New filename format: query-{N}-{reviewType}-{model}.md
      // Allows multiple perspectives on same query without overwriting
      const reviewFile = path.join(AI_REVIEWS_DIR, `query-${queryIndex}-${reviewType}-${model}.md`);
      fs.writeFileSync(reviewFile, review, 'utf-8');
      console.log(`   ✅ Saved: ${path.basename(reviewFile)}`);
      processed++;
    } else {
      skipped++;
    }
    
    console.log('');
  }
  
  console.log('═══════════════════════════════════════════════════════\n');
  console.log('✨ Review complete!\n');
  console.log(`📁 Reviews location: ${path.relative(WORKSPACE_ROOT, AI_REVIEWS_DIR)}`);
  console.log(`   (Run-isolated: ${runName}/ai-reviews/)`);
  console.log('');
  console.log('📊 Stats:');
  console.log(`   - Queries processed: ${processed}`);
  console.log(`   - Skipped (existing): ${skipped}`);
  console.log(`   - Review Type: ${reviewType}`);
  console.log(`   - Model: ${model}`);
  console.log('');
}

// Run the script
main().catch(error => {
  console.error('❌ Fatal error:', error.message);
  console.error(error.stack);
  process.exit(1);
});

