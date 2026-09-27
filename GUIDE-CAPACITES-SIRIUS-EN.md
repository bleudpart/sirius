# ΣIRIUS Assistant
## Complete capability inventory

**Reference version: 1.0.24**  
**Publisher: Daniel Partel**  
**Website: https://sirius-assistant.fr**

## How to read this guide

- **LOCAL**: works inside the Windows application with data stored on the computer.
- **CONFIGURABLE**: requires an API key, account, OAuth consent or user-provided URL.
- **OPTIONAL**: depends on an external service or available hardware.
- **PREPARATION**: an interface or engine exists, but the full integration still needs completion.
- **LIMIT**: does not replace certification, professional advice or human decisions.

## 1. ΣIRIUS core

ΣIRIUS is a Windows and web application built from a React interface, a Python/FastAPI backend and a configurable conversational engine.

It can:

- answer in French by text;
- receive French voice commands;
- use French speech synthesis;
- run as an installed or portable Windows application;
- start its local backend automatically;
- use local SQLite storage when MongoDB is unavailable;
- display service status, memory, network and CPU/RAM information;
- run in normal, frugal and emergency modes;
- show task progress and an operation journal;
- receive automatic updates from GitHub Releases;
- run as a PWA and be prepared for Android/iOS through Capacitor.

**Status: LOCAL for the application and backend; CONFIGURABLE for AI and external services.**

## 2. HUD and user experience

The ΣIRIUS HUD provides:

- animated central reactor;
- listening, thinking and speaking states;
- voice waveform visualization;
- clock, date, weather and CPU/RAM panels;
- command palette navigation;
- draggable and resizable work windows;
- keyboard shortcuts and voice commands;
- full-screen mode;
- Electron overlay mode with a global shortcut;
- startup presentation and voice sequence;
- 3D holographic hands and visual cortex;
- web and media windows;
- responsive mobile navigation;
- reduced-motion support.

The HUD is ΣIRIUS's visual signature. Business screens remain separate and focus on readable forms, tables, search, filters and printing.

## 3. Voice and conversation

ΣIRIUS can:

- listen through browser speech recognition;
- use Space as a push-to-talk key;
- convert speech into structured intents;
- correct frequent phonetic recognition errors;
- interrupt spoken responses with a new command;
- limit echo and false triggers;
- speak with a browser voice or configured TTS service;
- adjust speech rate and voice settings;
- read long answers on request;
- open modules by voice;
- launch media, notes, tasks, documents and searches by voice;
- provide visual feedback while listening and responding.

**Limit:** voice recognition depends on browser, microphone and Windows permissions.

## 4. AI and reliable answers

The AI engine can:

- answer in French;
- detect commands and user intents;
- search the web when a search key is configured;
- summarize briefings and documents;
- produce structured answers;
- generate architecture diagrams;
- suggest corrective actions;
- review code without executing it;
- generate plans from natural-language descriptions;
- use a brainstorming mode;
- preserve conversation context;
- expose network and service errors instead of silently hiding failures.

**Professional rule:** health, accounting, legal, financial, regulatory and safety decisions must be checked by a qualified human.

## 5. Memory and local learning

The memory system provides:

- personal memories saved on request or automatically;
- an editable “What ΣIRIUS knows about me” panel;
- dated long-term memory;
- preference, project and memory categories;
- local SQLite memory;
- keyword search;
- offline multilingual semantic recall with local embeddings;
- event and habit journaling;
- confidence score and daily suggestions;
- memory editing and deletion;
- memory export and backup;
- user-level or company-level data isolation when authentication is active.

## 6. ΣIRIUS Enterprise

The Enterprise module provides:

- company workspace creation;
- multiple establishments with name, address and active status;
- team members;
- administrator, manager, operator and viewer roles;
- module permissions for HACCP, documents, audit, sites, members, backups, THÉMIS and integrations;
- adding an existing account by e-mail;
- controlled role changes;
- owner administrator protection;
- dashboard counts for members, sites, documents, audits and open non-conformities;
- license and support status;
- global search across members and audit events;
- audit action filters;
- printable audit journal;
- mobile-friendly layout;
- company-scoped workflows and backups.

Online billing and automatic subscription management still require a payment provider integration before they can be considered operational.

## 7. Accounts, security and GDPR

ΣIRIUS provides:

- e-mail/password accounts;
- local-machine session protection;
- signed access tokens;
- HttpOnly, Secure and SameSite Strict cookies;
- session refresh;
- login-attempt throttling;
- password reset by configured e-mail service;
- bcrypt password hashing;
- MFA/TOTP with QR code;
- encrypted MFA secret storage;
- MFA code required after activation;
- unique user indexes and legacy index migration;
- module permissions;
- user and company data isolation;
- GDPR personal-data export as a ZIP archive;
- confirmed account deletion;
- protection against deleting the main administrator account;
- audit logging for sensitive actions;
- safe upload types and paths;
- upload size limits;
- tracked-secret detection during release audits.

For professional deployment, also use Windows account protection, disk encryption, encrypted backups, retention rules and a legal GDPR review.

## 8. HACCP and food safety

The HACCP module manages:

- receipt and traceability records;
- product, lot, supplier, quantity and use-by date;
- receiving temperature;
- positive-cold, freezer and hot-holding equipment;
- temperature readings with thresholds;
- non-compliant reading detection;
- temperature history;
- the food safety management plan;
- PMS procedure statuses;
- non-conformities;
- minor, major and critical severity;
- anomaly descriptions;
- corrective actions;
- confirmed non-conformity closure;
- cleaning and disinfection plans;
- zones, products, frequencies and responsible staff;
- cleaning task validation;
- the 14 EU allergens reference list;
- dish-level allergen sheets;
- mandatory-document register;
- issue and expiry dates;
- persistent control sheets;
- voice dictation for control sheets;
- compliant, non-compliant or not-applicable results;
- human validation with identity and date;
- control history;
- blank printable HACCP forms;
- pre-filled HACCP forms;
- printable product labels;
- audit PDF with period, sources, controls and validation status;
- HACCP backup and restore;
- HACCP permissions;
- audit events for creations, validations and reports.

**Limit:** the report is an internal preparation and traceability tool, not an official certification.

## 9. THÉMIS: business, sales and finance

THÉMIS can manage:

- customer records;
- quotes and invoices;
- invoice lines, quantities and unit prices;
- net, VAT and gross totals;
- document numbering;
- draft, sent, accepted, paid and refused statuses;
- due dates;
- payments and payment methods;
- customer reminders;
- orders and order statuses;
- document templates;
- antique, modern and minimal templates;
- PDF generation;
- e-mail delivery when SMTP is configured;
- supplier documents in PDF, PNG, JPG and WEBP;
- OCR/AI extraction from supplier documents;
- accounting journal;
- VAT summary;
- bank reconciliation;
- cash-flow forecast;
- accounting and CSV exports;
- stock items;
- references, prices, initial stock and alert thresholds;
- low-stock alerts;
- stock entries and exits;
- movement reasons;
- before/after quantities;
- per-item movement history.

**Limit:** THÉMIS is a monitoring and management tool; it is not certified legal accounting software and does not replace an accountant.

## 10. CRM and sales

The commercial tools include:

- contacts and address book;
- clients and companies;
- HERMÈS AGORA sales pipeline;
- prospects and opportunities;
- sales stages;
- amounts and commission preparation;
- sales objectives;
- objection coaching;
- interaction history;
- reminders;
- conversion of won deals into THÉMIS quotes or invoices;
- commercial exports;
- audit logging of key actions.

## 11. Productivity and project work

Productivity tools provide:

- notes and SmartNotes;
- tasks and TaskMaster;
- deadlines;
- task states;
- live task windows;
- long-operation progress tracking;
- reports and ReportBuilder;
- local document analysis;
- code analysis;
- Dev Companion review;
- project memory;
- architecture diagrams;
- spectator/casting view for diagrams.

**Preparation:** complete Gantt charts, detailed time tracking, workload allocation and project budgets still require a dedicated module.

## 12. Documents, media and storage

ΣIRIUS provides:

- file and media library;
- upload, list, download and logical deletion;
- images, audio, PDF, text, CSV and XLSX support depending on route;
- document analysis;
- inline audio playback;
- image thumbnails;
- Enterprise document vault;
- local Windows storage;
- local fallback when external storage is not configured;
- company metadata and file backups;
- path and type validation;
- file-size limits;
- PDF, CSV and XLSX exports depending on module;
- DXF and SVG exports from PLANS#;
- direct printing of business forms.

**Preparation:** external cloud synchronization such as NAS, OneDrive, Google Drive or S3 can be connected according to business needs.

## 13. Outlook, Gmail, calendar and contacts

### Microsoft 365

With Microsoft OAuth configured, and depending on granted scopes, ΣIRIUS can provide:

- Outlook mailbox access;
- e-mail search and reading;
- important-message briefing;
- e-mail sending after confirmation;
- protected sensitive actions;
- Microsoft calendar events;
- today's schedule;
- event creation or editing where scopes allow it;
- Outlook contacts;
- contact folders;
- token refresh;
- reconnection when authorization expires.

### Google

With Google OAuth configured, the authorized services can provide:

- Google Calendar;
- event creation and reading;
- agenda reminders;
- Gmail access where scopes allow it;
- message reading for briefings and authorized workflows.

ΣIRIUS never asks for Google or Microsoft passwords.

## 14. Home Assistant and equipment

KERAUNOS# can provide, with a Home Assistant URL and token:

- REST connection to Home Assistant;
- entity-state reading;
- voice commands;
- authorized device control;
- clear service-unavailable errors;
- locally managed connection settings.

Professional equipment support depends on its API or Home Assistant compatibility.

## 15. PLANS# and geometry

PLANS# can:

- turn a natural-language description into a plan;
- create rooms and surfaces;
- calculate areas and perimeters;
- display a 2D color view;
- display an isometric 3D view;
- calculate dimensions and measurements;
- export DXF;
- export SVG;
- open output in AutoCAD, LibreCAD or QCAD;
- accept commands such as “draw a 6 by 4 metre garage”.

## 16. Vision, OCR and media

ΣIRIUS can provide:

- camera capture;
- Electron screen capture;
- OCR and screen summarization with configured vision AI;
- image analysis;
- 3D holographic hands;
- visual cortex;
- MYTHOS gallery;
- Europeana archives;
- country sheets;
- news;
- documentaries;
- weather;
- Spotify now-playing information;
- YouTube, Twitch, TikTok and Deezer through official players;
- WebSocket media-window synchronization;
- TRAILER# cinematic shots;
- PACKAGER# multi-platform deliverables.

## 17. Supervision and maintenance

PANTHEON SYSTEM, NEXUS, ARGUS and HÉPHAÏSTOS provide:

- process supervision;
- CPU/RAM monitoring;
- network status;
- connectivity checks;
- service history;
- local diagnostics;
- module checks;
- proactive monitoring;
- normal, frugal and emergency modes;
- protected maintenance actions;
- self-repair controls;
- local backups with manifest and SHA-256;
- integrity verification;
- Enterprise restore;
- sensitive-operation logging.

## 18. ORACLE DIVIN and SIRIUS PRIME

ORACLE DIVIN can display:

- morning briefing;
- multi-day weather;
- cryptocurrency prices where APIs are available;
- market trends;
- news and estimated impact;
- moon phase and astronomy information;
- personal predictions based on recorded habits.

SIRIUS PRIME can display:

- learning journal;
- habits by hour and day;
- frequent intents;
- confidence score;
- daily suggestions;
- memory management.

**Limit:** predictions and estimates are not financial or scientific guarantees.

## 19. Installer, updates and quality

The project provides:

- Windows NSIS installer;
- Windows portable build;
- installer license display;
- automatic local backend startup;
- desktop and Start Menu shortcuts;
- controlled data retention on uninstall;
- Electron automatic updates;
- differential-update blockmap;
- GitHub Releases;
- secret audit;
- backend and frontend tests;
- restore tests;
- security tests;
- GitHub bug template;
- Enterprise and support documentation;
- embedded-frontend verification;
- version-regression checks.

## 20. Limits and responsibility

ΣIRIUS is an assistant and business-tools platform. It is not:

- a certified accountant;
- a lawyer;
- certified payroll software;
- an official HACCP certification;
- a medical device;
- a safety authority;
- a qualified electronic signature;
- a guarantee of financial or commercial results;
- a replacement for human validation.

Critical data must be checked, backed up and validated by a qualified person. External integrations have their own accounts, permissions, keys and terms of service.

## 21. References and support

- Store: https://sirius-assistant.fr
- API: https://api.sirius-assistant.fr
- GitHub: https://github.com/bleudpart/sirius
- Support: danielpartel@hotmail.com
- Secondary support: danielsirius.pro2026@gmail.com
- Phone: 06 60 66 74 36

© 2026 Daniel Partel – ΣIRIUS Assistant. All rights reserved.
