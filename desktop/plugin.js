import { host, useValue, gatewayActivationEpoch, useGatewayActivationEpoch, useQuery, useMutation, useQueryClient, Button, Input, Textarea, ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA } from '@hermes/plugin-sdk'
import { useState, useRef, useEffect, useLayoutEffect, createElement as h } from 'react'

// Review + explicit opt-in still-image generation. Generation is dispatched ONLY by a confirmed click
// (never by saving, mounting, tab changes or polling) through the backend, which owns provider access.
// No payment, external media URLs or credentials in the UI.
// Styling uses host theme tokens only and is scoped to .retake.
// Layout: project rail | project panel | work area. The work area is a grid with a persistent media stage,
// a compact version filmstrip and one Review inspector that docks right (wide) or below (constrained).

const RAIL_W = 56 // project covers
const PANEL_W = 212 // the open project's panel
const NARROW_ROOT = 900 // route width below which the project panel folds into a toggle
const BOTTOM_DOCK = 820 // work-area width below which the inspector docks under the stage
const THUMB_B64_LIMIT = 349600 // 256 KiB PNG, base64-encoded
const MEDIA_MIME = /^(image\/(png|jpeg|webp)|video\/mp4)$/
// Video upload is hidden until tested natively; the backend still accepts MP4 and stored videos still play.
const VIDEO_UPLOADS = globalThis.RETAKE_ENABLE_VIDEO_UPLOADS === true
const UPLOAD_MIMES = ['image/png', 'image/jpeg', 'image/webp', ...(VIDEO_UPLOADS ? ['video/mp4'] : [])]
const UPLOAD_ACCEPT = UPLOAD_MIMES.join(',')
const UPLOAD_KINDS = VIDEO_UPLOADS ? 'PNG, JPEG, WebP, MP4' : 'PNG, JPEG, WebP'

const cssBase = `
.retake{container:rt-root / inline-size;display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;color:var(--ui-text-primary);font:inherit;font-size:13px;line-height:1.45;box-sizing:border-box}
.retake *{box-sizing:border-box}
.retake h1,.retake h2,.retake h3,.retake h4,.retake p,.retake ul,.retake ol,.retake dl,.retake dd,.retake figure{margin:0}
.retake h1{font-size:15px;font-weight:650;letter-spacing:-.01em;line-height:1.2}
.retake h2{font-size:14px;font-weight:600;line-height:1.3}
.retake h3{font-size:13px;font-weight:600;line-height:1.35}
.retake :is(h2,h3,p,li,dd){overflow-wrap:anywhere}
.retake button,.retake input,.retake textarea,.retake select{font:inherit}
.retake input:not([type=checkbox]):not([type=file]),.retake textarea,.retake select{color:var(--ui-text-primary);background:var(--ui-bg-editor);border:1px solid var(--ui-stroke-secondary);border-radius:6px;padding:5px 8px;min-width:0;max-width:100%}
.retake textarea{width:100%;min-height:56px;resize:vertical;line-height:1.5}
.retake :is(input,textarea,select):disabled{opacity:.6;cursor:not-allowed}
.retake :is(button,input,textarea,select,summary,[tabindex]):focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}
.retake button{cursor:pointer;white-space:normal}
.retake button:disabled{cursor:not-allowed;opacity:.5}
.retake label{display:flex;flex-direction:column;gap:4px;min-width:0;max-width:100%;font-size:12px;color:var(--ui-text-secondary)}
`

const cssUtility = `
.retake .rt-row{display:flex;align-items:center;gap:6px 8px;flex-wrap:wrap}
.retake .rt-row>*{min-width:0;max-width:100%}
.retake .rt-between{justify-content:space-between}
.retake .rt-muted{color:var(--ui-text-secondary);font-size:12px;line-height:1.5}
.retake .rt-opt{display:inline-flex;align-items:center;margin-left:6px;padding:0 6px;border:1px solid var(--ui-stroke-secondary);border-radius:999px;background:var(--ui-bg-secondary);color:var(--ui-text-secondary);font-size:11px;font-weight:500;line-height:1.6;vertical-align:1px;white-space:nowrap}
.retake .rt-eyebrow{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ui-text-secondary)}
.retake .rt-id{font-size:11px;font-variant-numeric:tabular-nums;color:var(--ui-text-quaternary,var(--ui-text-secondary));overflow-wrap:anywhere;user-select:all}
.retake .rt-trunc{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.retake .rt-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.retake .rt-pill{display:inline-flex;align-items:center;gap:5px;border:0;border-radius:0;padding:1px 4px;font-size:11px;line-height:1.6;color:var(--ui-text-secondary);white-space:nowrap}
.retake .rt-flag{display:inline-flex;align-items:center;gap:3px;flex:none;min-width:0;font-size:11px;line-height:16px;font-weight:600;white-space:nowrap}
.retake .rt-flag svg{flex:none}
.retake .rt-flag[data-mark=main]{color:var(--ui-accent)}
.retake .rt-flag[data-mark=hidden]{color:var(--ui-text-secondary);font-weight:500}
.retake .rt-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--ui-text-secondary)}
.retake .rt-icon:hover:not(:disabled){background:var(--ui-bg-secondary);color:var(--ui-text-primary)}
.retake .rt-tabs{display:inline-flex;gap:2px;padding:2px;border:0;border-radius:0;background:transparent;flex:none}
.retake .rt-tabs [role=tab]{border:0;border-radius:0;padding:3px 12px;background:transparent;color:var(--ui-text-secondary);font-size:12px;font-weight:500;white-space:nowrap}
.retake .rt-tabs [role=tab]:hover:not(:disabled){color:var(--ui-text-primary)}
.retake .rt-tabs [role=tab][aria-selected=true]{background:transparent;color:var(--ui-text-primary);font-weight:600;box-shadow:inset 0 -2px 0 var(--ui-accent)}
/* Toasts float top-centre of the work area, just under its header row, from a zero-height anchor: no layout shift,
   and the header's controls stay clear. The background is layered over the editor colour so a translucent theme
   colour never lets the image show through. */
.retake .rt-toasts{grid-area:main;align-self:start;justify-self:stretch;position:relative;height:0;min-width:0;z-index:15;pointer-events:none}
.retake .rt-toast-stack{position:absolute;top:calc(var(--rt-bar-h) + 8px);left:50%;transform:translateX(-50%);width:max-content;max-width:min(560px,calc(100% - 24px));display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none}
.retake .rt-toast{pointer-events:auto;display:flex;align-items:center;gap:10px;max-width:100%;padding:7px 6px 7px 12px;border:1px solid var(--ui-text-secondary);border-radius:8px;background:linear-gradient(var(--ui-bg-secondary),var(--ui-bg-secondary)),var(--ui-bg-editor);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);box-shadow:0 10px 30px rgba(0,0,0,.55);color:var(--ui-text-primary);font-size:13px;font-weight:500}
.retake .rt-toast::before{content:"";flex:none;width:8px;height:8px;border-radius:50%;background:var(--ui-accent)}
.retake .rt-toast[data-kind=error]{border-color:var(--ui-accent)}
.retake .rt-toast>span{flex:1;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}
.retake .rt-toast strong{font-weight:600}
.retake .rt-toast-act{flex:none;padding:2px 10px;border:1px solid var(--ui-accent);border-radius:6px;background:var(--ui-accent);color:var(--ui-bg-editor);font-size:12px;font-weight:600;line-height:1.6}
.retake .rt-x{flex:none;background:transparent;border:0;border-radius:4px;padding:2px 6px;color:var(--ui-text-secondary);font-size:15px;line-height:1}
.retake .rt-x:hover{color:var(--ui-text-primary)}
`

const cssShell = `
/* Header: product, project > asset breadcrumb, Review | Compare mode, scope pills. */
/* One type size (13px) across breadcrumb, asset picker and mode tabs; weight and colour carry hierarchy. */
.retake .rt-top{display:flex;align-items:center;flex-wrap:wrap;gap:6px 16px;box-sizing:border-box;padding:6px 14px;border-bottom:1px solid var(--ui-stroke-secondary);flex:none;min-height:44px}
.retake .rt-crumbs{display:flex;align-items:center;flex-wrap:wrap;gap:4px 6px;flex:1 1 300px;min-width:0}
.retake .rt-crumbs h1{font-size:13px;font-weight:600;color:var(--ui-text-secondary);letter-spacing:0}
.retake .rt-asset-name{font-size:13px;font-weight:600;max-width:min(280px,100%)}
.retake .rt-sep{color:var(--ui-text-secondary);opacity:.7}
.retake .rt-crumbs .rt-icon{width:22px;height:22px;min-height:0;padding:0}
.retake .rt-crumb{padding:0 3px;line-height:1.5;min-height:0;border:0;border-radius:4px;background:transparent;color:var(--ui-text-secondary);font-size:13px;font-weight:600;cursor:pointer;max-width:min(28ch,100%);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.retake .rt-crumb:hover:not(:disabled){color:var(--ui-text-primary);text-decoration:underline}
.retake .rt-crumb[aria-current=page]{color:var(--ui-text-primary);cursor:default;text-decoration:none}
.retake .rt-panel-toggle[aria-expanded=true]{color:var(--ui-text-primary)}
.retake .rt-menu-wrap{position:relative;display:inline-flex}
.retake .rt-menu{position:absolute;top:calc(100% + 4px);left:0;z-index:20;min-width:180px;padding:4px;border:1px solid var(--ui-stroke-secondary);border-radius:6px;background:var(--ui-bg-editor);box-shadow:0 8px 24px rgba(0,0,0,.35)}
.retake .rt-menu [role=menuitem]{display:block;width:100%;padding:6px 8px;border:0;border-radius:4px;background:transparent;color:var(--ui-text-primary);font-size:12px;text-align:left;cursor:pointer}
.retake .rt-menu [role=menuitem]:hover,.retake .rt-menu [role=menuitem]:focus-visible{background:var(--ui-bg-secondary)}
.retake .rt-overview{overflow:auto}
/* All assets and All versions share one card grid: same track, gap, card padding, thumbnail (4:3) and text height. */
.retake .rt-assets,.retake .rt-vgrid{list-style:none;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--rt-card-min,168px),1fr));gap:12px;align-content:start}
.retake .rt-assets{padding:12px 14px}
.retake .rt-vgrid{padding:0}
.retake .rt-asset-card,.retake .rt-vtile{display:flex;flex-direction:column;gap:6px;width:100%;padding:6px 6px 8px;border:1px solid transparent;border-radius:6px;background:color-mix(in srgb,var(--ui-bg-secondary) 65%,transparent);color:var(--ui-text-primary);text-align:left;cursor:pointer}
.retake .rt-asset-card:hover:not(:disabled),.retake .rt-asset-card:focus-visible{border-color:var(--ui-accent)}
.retake :is(.rt-assets,.rt-vgrid) .rt-asset-card .rt-thumb,.retake .rt-assets .rt-asset-card .rt-cover{width:100%;height:auto;aspect-ratio:4/3;font-size:20px}
.retake .rt-assets .rt-asset-card .rt-cover img{width:100%;height:100%;object-fit:contain}
.retake .rt-asset-card[data-attempt],.retake .rt-asset-card[data-editing]{cursor:default}
.retake .rt-asset-item{position:relative}
.retake .rt-rename-btn{position:absolute;top:10px;right:10px;width:26px;height:26px;opacity:0;background:var(--ui-bg-editor);border:1px solid var(--ui-stroke-secondary);border-radius:6px}
.retake .rt-asset-item:hover .rt-rename-btn,.retake .rt-rename-btn:focus-visible{opacity:1}
@media (hover:none){.retake .rt-rename-btn{opacity:1}}
.retake .rt-rename{width:100%;padding:3px 6px;font-size:13px;font-weight:600}
.retake .rt-new-sizer{display:flex;flex-direction:column;gap:6px;padding:6px 6px 8px;border:1px solid transparent;visibility:hidden}
.retake .rt-new-sizer::before{content:'';aspect-ratio:4/3}
.retake .rt-new-sizer::after{content:'';height:40px}
.retake .rt-new-tile{position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden;border:1px dashed var(--ui-stroke-secondary);border-radius:6px;color:var(--ui-text-secondary)}
.retake .rt-new-half{flex:1 1 0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;min-height:0;padding:6px;border:0;border-radius:0;background:transparent;color:inherit;font-size:12px;font-weight:600}
.retake .rt-new-half+.rt-new-half{border-top:1px dashed var(--ui-stroke-secondary)}
.retake .rt-new-half svg{width:16px;height:16px}
.retake .rt-new-why{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;max-width:100%;color:var(--ui-text-secondary);font-size:11px;font-weight:400;line-height:1.3;text-align:center;overflow-wrap:anywhere}
.retake .rt-new-retry{padding:2px 10px;font-size:11.5px;font-weight:600}
.retake .rt-choice[data-state=failed]{cursor:default}
.retake button.rt-new-half:hover:not(:disabled){background:color-mix(in srgb,var(--ui-accent) 14%,transparent);color:var(--ui-text-primary)}
.retake button.rt-new-half:focus-visible{outline-offset:-2px}
.retake .rt-new-tile[data-drop=true]{border:1px solid var(--ui-accent);background:color-mix(in srgb,var(--ui-accent) 12%,transparent);color:var(--ui-text-primary)}
.retake .rt-run-card .rt-thumb{background:repeating-linear-gradient(45deg,var(--ui-bg-secondary) 0 6px,color-mix(in srgb,var(--ui-bg-secondary) 55%,transparent) 6px 12px)}
.retake .rt-run-card[data-attempt=failed] .rt-thumb{background:var(--ui-bg-secondary)}
.retake .rt-run-x{display:flex;align-items:center;justify-content:center;width:22px;height:22px;border:1.5px solid #e5484d;border-radius:50%;color:#e5484d;font-size:13px;font-weight:700}
.retake .rt-run-fail{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;color:var(--ui-text-secondary);font-size:12px;line-height:1.4}
.retake .rt-run-dismiss{opacity:1}
/* New-asset composer: a dialog in the middle of the dimmed page. */
.retake .rt-compose-wrap{z-index:45}
.retake .rt-composer{outline:none;display:flex;flex-direction:column;gap:10px;width:min(560px,100%);max-height:100%;overflow:auto;padding:14px;border:1px solid var(--ui-stroke-secondary);border-radius:12px;background:var(--ui-bg-editor);box-shadow:0 16px 48px rgba(0,0,0,.5)}
.retake .rt-composer textarea{min-height:120px;font-size:14px;padding:10px;border-radius:8px}
.retake .rt-compose-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.retake .rt-compose-go{display:flex;gap:8px;margin-left:auto}
.retake .rt-compose-row .rt-model-row{flex:0 1 auto}
.retake .rt-kbd-hint{margin-left:6px;font:inherit;font-size:11px;opacity:.75}
.retake .rt-composer .rt-confirm-charge{font-size:12px;color:var(--ui-text-secondary)}
.retake .rt-shapes.rt-seg{display:inline-flex;gap:0;border:1px solid var(--ui-stroke-secondary);border-radius:6px;overflow:hidden}
.retake .rt-seg .rt-shape{flex-direction:row;align-items:center;gap:5px;padding:3px 9px;border:0;border-radius:0}
.retake .rt-seg .rt-shape+.rt-shape{border-left:1px solid var(--ui-stroke-secondary)}
.retake .rt-seg .rt-shape:focus-visible{outline-offset:-2px}
.retake .rt-seg .rt-shape-box[data-shape=landscape]{width:14px;height:9px}
.retake .rt-seg .rt-shape-box[data-shape=square]{width:10px;height:10px}
.retake .rt-seg .rt-shape-box[data-shape=portrait]{width:8px;height:12px}
@container rt-root (max-width:520px){.retake .rt-seg .rt-shape-box{display:none}}
.retake .rt-asset-text{display:flex;flex-direction:column;gap:3px;min-width:0;min-height:40px;font-size:12px}
.retake .rt-asset-text strong{font-size:13px;font-weight:600}
.retake .rt-asset-meta{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;color:var(--ui-text-secondary)}
.retake{position:relative}
.retake .rt-overlay{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(8,8,12,.6)}
.retake .rt-lb{z-index:50;flex-direction:column;align-items:stretch;justify-content:flex-start;gap:8px;padding:10px 12px 12px;background:#06060a;color:#f2f0f6}
.retake .rt-lb:focus{outline:none}
.retake .rt-lb-top{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px}
.retake .rt-lb-top>span{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.75}
.retake .rt-lb :is(.rt-lb-close,.rt-lb-nav){flex:none;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border:1px solid rgba(255,255,255,.22);border-radius:50%;background:rgba(255,255,255,.06);color:#f2f0f6;font-size:15px;line-height:1}
.retake .rt-lb :is(.rt-lb-close,.rt-lb-nav):hover:not(:disabled){background:rgba(255,255,255,.16)}
.retake .rt-lb-body{flex:1 1 0;min-height:0;display:flex;align-items:center;gap:8px}
.retake .rt-lb-media{flex:1 1 0;min-width:0;align-self:stretch;display:flex;align-items:center;justify-content:center;line-height:0}
.retake .rt-lb-media :is(img,video){display:block;width:100%;height:100%;object-fit:contain}
.retake .rt-lb-media img[data-pixels=true]{image-rendering:pixelated}
.retake .rt-lb-media .rt-wait{color:#f2f0f6;line-height:1.5}
.retake .rt-lb-dots{display:flex;justify-content:center;gap:6px;flex:none}
.retake .rt-lb-dots i{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.3)}
.retake .rt-lb-dots i[data-on=true]{background:#fff}
@container rt-root (max-width:600px){.retake .rt-lb{padding:8px}.retake .rt-lb-body{gap:4px}.retake .rt-lb :is(.rt-lb-nav){width:30px;height:30px}}
.retake .rt-dialog{display:flex;flex-direction:column;gap:10px;width:min(420px,100%);padding:18px 20px;border:1px solid var(--ui-stroke-secondary);border-radius:8px;background:var(--ui-bg-editor);box-shadow:0 16px 48px rgba(0,0,0,.5);font-size:13px}
.retake .rt-dialog h2{font-size:14px;font-weight:600}
.retake .rt-dialog p{color:var(--ui-text-secondary)}
.retake .rt-dialog .rt-row{justify-content:flex-end;gap:8px}
.retake .rt-dialog .rt-dialog-error{color:var(--ui-text-primary);padding:6px 8px;border-left:3px solid #e5484d;background:var(--ui-bg-secondary)}
.retake button.rt-danger{border-color:#c4363b;background:#c4363b;color:#fff}
.retake button.rt-danger:hover:not(:disabled){background:#d63e44}
.retake .rt-menu [role=menuitem]:disabled{color:var(--ui-text-secondary);opacity:.5;cursor:not-allowed;background:transparent}
.retake .rt-marks{gap:2px;flex:none}
/* Stage: "★ Main" toggle (pressed = this version is the asset's Main), a Hidden chip when hidden, then ⋯. */
.retake .rt-marks>button{display:inline-flex;align-items:center;gap:4px;flex:none;min-height:24px;padding:1px 7px;border:1px solid transparent;border-radius:999px;background:transparent;color:var(--ui-text-secondary);font-size:12px;cursor:pointer;white-space:nowrap}
.retake .rt-marks>button:hover:not(:disabled),.retake .rt-marks>button[aria-expanded=true]{border-color:var(--ui-stroke-secondary);background:var(--ui-bg-secondary);color:var(--ui-text-primary)}
.retake .rt-marks>button:disabled{opacity:.55;cursor:progress}
.retake .rt-marks>.rt-main-btn[aria-pressed=true]{color:var(--ui-accent);font-weight:600}
.retake .rt-marks>.rt-more{padding:1px 5px}
.retake .rt-menu .rt-kbd{margin-left:auto;padding-left:16px;font-size:11px;color:var(--ui-text-secondary)}
.retake .rt-marks-menu [role=menuitem]{display:flex;align-items:center;gap:7px;white-space:nowrap}
.retake .rt-menu [role=menuitemradio]{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;border:0;border-radius:4px;background:transparent;color:var(--ui-text-primary);font-size:12px;text-align:left;cursor:pointer;white-space:nowrap}
.retake .rt-menu [role=menuitemradio]:hover,.retake .rt-menu [role=menuitemradio]:focus-visible{background:var(--ui-bg-secondary)}
.retake .rt-menu .rt-mcheck{width:12px;color:var(--ui-accent)}
.retake .rt-menu-why{display:block;max-width:220px;padding:0 8px 6px;font-size:11px;color:var(--ui-text-secondary)}
.retake .rt-top .rt-tabs [role=tab]{font-size:13px;padding:5px 10px}
.retake .rt-top-tools{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;margin-left:auto}
.retake .rt-scope{max-width:24ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--ui-text-secondary)}
.retake .rt-top-tools .rt-icon{width:26px;height:26px;opacity:.85}
.retake .rt-top-tools .rt-icon:hover:not(:disabled){opacity:1}

/* Shell: project rail | project panel | work area. Below NARROW_ROOT the panel floats over the work area. */
.retake .rt-shell{position:relative;flex:1 1 0;min-height:0;min-width:0;display:grid;grid-template-columns:${RAIL_W}px var(--rt-panel,0px) minmax(0,1fr)}
.retake .rt-shell>.rt-work{grid-column:3}

/* Project rail: All projects, one cover per project (the open one outlined), New project. */
.retake .rt-rail{grid-column:1;display:flex;flex-direction:column;align-items:center;gap:8px;min-width:0;min-height:0;padding:10px 0;border-right:1px solid var(--ui-stroke-secondary);background:color-mix(in srgb,var(--ui-bg-secondary) 45%,transparent)}
.retake .rt-projects{list-style:none;padding:4px 0;display:flex;flex-direction:column;align-items:center;gap:10px;flex:0 1 auto;min-height:0;overflow-y:auto;scrollbar-width:none;width:100%}
.retake .rt-proj{display:flex;padding:0;border:0;border-radius:8px;background:transparent;outline-offset:2px}
.retake .rt-proj .rt-cover{width:36px;height:36px;border-radius:8px}
.retake .rt-proj:hover:not(:disabled) .rt-cover{border-color:var(--ui-text-secondary)}
.retake .rt-proj[aria-current=true] .rt-cover{box-shadow:0 0 0 2px var(--ui-bg-editor),0 0 0 4px var(--ui-accent)}
.retake .rt-rail-btn{width:36px;height:36px;border-color:var(--ui-stroke-secondary);border-radius:8px}
.retake .rt-rail-btn[aria-current=page]{border-color:var(--ui-accent);color:var(--ui-text-primary)}
.retake .rt-cover{display:flex;align-items:center;justify-content:center;width:36px;height:36px;flex:none;overflow:hidden;border:1px solid var(--ui-stroke-secondary);border-radius:6px;background:var(--ui-bg-secondary);color:var(--ui-text-secondary);font-size:12px;font-weight:600;letter-spacing:.02em}
.retake .rt-cover img{display:block;width:100%;height:100%;object-fit:cover}
/* New project: a small form beside the rail's + (anchored to the root, so the rail never clips it). */
.retake .rt-new{position:absolute;z-index:30;display:flex;flex-direction:column;gap:6px;width:240px;max-width:calc(100% - 16px);padding:8px;border:1px solid var(--ui-stroke-secondary);border-radius:8px;background:var(--ui-bg-editor);box-shadow:0 8px 24px rgba(0,0,0,.35)}
.retake .rt-new input{width:100%}

/* Project panel: name + actions, search, All assets / All versions, the assets. */
.retake .rt-panel{grid-column:2;display:flex;flex-direction:column;gap:2px;min-width:0;min-height:0;overflow-y:auto;padding:10px 8px;border-right:1px solid var(--ui-stroke-secondary);background:var(--ui-bg-editor)}
.retake .rt-panel[data-float=true]{grid-column:auto;position:absolute;z-index:16;top:0;bottom:0;left:${RAIL_W}px;width:min(${PANEL_W}px,calc(100% - ${RAIL_W}px));box-shadow:8px 0 24px rgba(0,0,0,.3)}
.retake .rt-panel-head{display:flex;align-items:center;gap:4px;min-height:28px;padding:0 0 6px 4px}
.retake .rt-panel-head h2{flex:1;min-width:0;font-size:13px}
.retake .rt-panel-head .rt-rename{flex:1}
.retake .rt-panel-head .rt-icon{width:24px;height:24px}
.retake .rt-search{width:100%;margin-bottom:6px;font-size:12px}
.retake .rt-pnav{list-style:none;padding:0;display:flex;flex-direction:column;gap:1px}
.retake .rt-pitem{display:flex;align-items:center;gap:8px;width:100%;min-height:28px;padding:3px 6px;border:0;border-radius:5px;background:transparent;color:var(--ui-text-secondary);font-size:12px;text-align:left}
.retake .rt-pitem:hover:not(:disabled){background:var(--ui-bg-secondary);color:var(--ui-text-primary)}
.retake .rt-pitem[aria-current=page]{background:var(--ui-bg-secondary);color:var(--ui-text-primary);font-weight:600}
.retake .rt-pitem>svg{flex:none;width:14px}
.retake .rt-pnav .rt-pitem .rt-thumb{width:28px;height:20px;flex:none;border-radius:3px;font-size:0}
.retake .rt-pitem-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.retake .rt-pitem-n{flex:none;font-size:11px;font-variant-numeric:tabular-nums;color:var(--ui-text-secondary);font-weight:400}
.retake .rt-panel h3.rt-eyebrow{margin:10px 0 2px;padding-left:6px;font-size:10.5px}
.retake .rt-panel .rt-muted{padding:2px 6px}

/* All versions: thumbnails by asset or by date. */
.retake .rt-allv{overflow:auto}
.retake .rt-allv-body{display:flex;flex-direction:column;gap:14px;padding:12px 14px}
.retake .rt-allv h4{margin:0 0 6px;font-size:12px;font-weight:600;color:var(--ui-text-secondary)}
.retake .rt-vtile:hover:not(:disabled),.retake .rt-vtile:focus-visible{border-color:var(--ui-accent)}
.retake .rt-vgrid .rt-vtile .rt-thumb{width:100%;height:auto;aspect-ratio:4/3;font-size:20px}
.retake .rt-vgrid .rt-vtile[data-mark=hidden] .rt-thumb{opacity:.45}
.retake .rt-allv .rt-view button{display:inline-flex;align-items:center;gap:4px}
.retake .rt-vtile-text{display:flex;align-items:flex-start;gap:6px;min-width:0;min-height:40px;font-size:12px}
.retake .rt-vtile-text b{flex:none;font-weight:600}
.retake .rt-vtile-text .rt-trunc{color:var(--ui-text-secondary)}

/* Work grid. data-dock is measured with ResizeObserver on the route container, not the window. */
.retake .rt-work{display:grid;min-width:0;min-height:0;grid-template-columns:minmax(0,1fr) 340px;grid-template-rows:minmax(0,1fr) auto;grid-template-areas:"main insp" "strip insp"}
.retake .rt-work[data-dock=bottom]{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(240px,3fr) auto minmax(200px,2fr);grid-template-areas:"main" "strip" "insp"}
.retake .rt-work[data-insp=none]{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(200px,1fr) auto;grid-template-areas:"main" "strip"}
`

const cssStage = `
.retake .rt-main{grid-area:main;display:flex;flex-direction:column;min-width:0;min-height:0}
.retake .rt-main-empty{align-items:center;justify-content:center;padding:20px;overflow:auto}
/* Every header row is the same height in every view; a row never grows a second line. */
.retake{--rt-bar-h:45px}
.retake[data-compact=true]{--rt-bar-h:35px}
.retake[data-tight=true]{--rt-bar-h:31px}
.retake .rt-bar{display:flex;align-items:center;justify-content:space-between;flex-wrap:nowrap;gap:6px 14px;box-sizing:border-box;height:var(--rt-bar-h);padding:0 14px;border-bottom:1px solid var(--ui-stroke-secondary);flex:none}
.retake .rt-bar-title{display:flex;align-items:center;flex-wrap:nowrap;gap:2px 8px;flex:1 1 220px;min-width:0}
.retake .rt-bar-title h3{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.retake .rt-bar-v{flex:none;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
.retake .rt-bar-title>.rt-dl{margin-left:4px}
.retake .rt-dl{display:inline-flex;align-items:center;gap:5px;flex:none;min-height:28px;padding:3px 10px;border:1px solid var(--ui-stroke-secondary);border-radius:6px;background:transparent;color:var(--ui-text-primary);font-size:12px;font-weight:500;line-height:1.4;white-space:nowrap}
.retake .rt-dl:hover:not(:disabled){border-color:var(--ui-text-secondary);background:var(--ui-bg-secondary)}
.retake .rt-dl-sm{min-height:22px;padding:1px 7px;font-size:11px}
.retake .rt-bar-dim{flex:none;font-size:11px;color:var(--ui-text-secondary);font-variant-numeric:tabular-nums}
/* Decision is one segmented control: three exclusive states, lighter than three free-standing buttons. */
/* The stage is a size container: media fit uses cq units so the annotation wrapper is exactly the rendered media box. */
.retake .rt-stage{position:relative;flex:1 1 0;min-height:150px;container-type:size;display:flex;align-items:center;justify-content:center;padding:12px;overflow:hidden;background:color-mix(in srgb,var(--ui-bg-secondary) 70%,transparent)}
/* Zoom frame: covers the whole stage (same padding, so Fit is unchanged); the media box inside is transformed. */
.retake .rt-zoom{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:inherit}
.retake .rt-zoom[data-grab],.retake .rt-zoom[data-grab] .rt-media{cursor:grab}
.retake .rt-zoom[data-grab=grabbing],.retake .rt-zoom[data-grab=grabbing] .rt-media{cursor:grabbing}
.retake .rt-media{position:relative;display:block;flex:none;line-height:0;touch-action:none;user-select:none;transform-origin:50% 50%}
.retake .rt-media[data-draw=true]{cursor:crosshair}
.retake .rt-media img,.retake .rt-media video{display:block;width:auto;height:auto;max-width:100cqw;max-height:100cqh}
/* Outlines and numbers keep their screen size at every zoom (--rt-z is the media box's scale). */
.retake .rt-region{position:absolute;border:calc(2px / var(--rt-z,1)) solid var(--ui-accent);border-radius:2px;background:color-mix(in srgb,var(--ui-accent) 15%,transparent);pointer-events:none}
.retake .rt-region[data-saved=true]{border-style:dashed}
.retake .rt-mark{position:absolute;z-index:1;border:calc(1px / var(--rt-z,1)) solid color-mix(in srgb,var(--ui-accent) 70%,transparent);border-radius:2px;pointer-events:none}
.retake .rt-mark[data-active=true]{border-width:calc(2px / var(--rt-z,1));border-color:var(--ui-accent)}
.retake .rt-mark-n,.retake .rt-note-n{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--ui-accent);color:var(--ui-bg-editor);font-size:10px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
.retake .rt-mark-n{position:absolute;left:-1px;top:-1px;transform-origin:0 0;transform:scale(calc(1 / var(--rt-z,1))) translate(-35%,-35%);opacity:.92}
.retake .rt-zoombar{position:absolute;right:8px;bottom:8px;z-index:2;display:flex;gap:2px;padding:2px;border:1px solid var(--ui-stroke-secondary);border-radius:7px;background:color-mix(in srgb,var(--ui-bg-editor) 88%,transparent);line-height:1}
.retake .rt-zoombar[data-video=true]{bottom:auto;top:8px}
.retake .rt-zoombar button{min-width:26px;height:24px;padding:0 6px;border:0;border-radius:5px;background:transparent;color:var(--ui-text-primary);font-size:13px;line-height:1;font-variant-numeric:tabular-nums;white-space:nowrap}
.retake .rt-zoombar button:hover:not(:disabled){background:var(--ui-bg-secondary)}
.retake .rt-zoombar .rt-zoom-level{min-width:44px;font-size:12px}
.retake .rt-tools{display:flex;gap:2px;padding-right:2px;margin-right:2px;border-right:1px solid var(--ui-stroke-secondary)}
.retake .rt-zoombar .rt-tools button{display:inline-flex;align-items:center;justify-content:center;color:var(--ui-text-secondary)}
.retake .rt-zoombar .rt-tools button[aria-pressed=true]{background:var(--ui-bg-secondary);color:var(--ui-accent)}
.retake .rt-stage[data-gen=true] .rt-zoom{filter:saturate(.3) brightness(.55)}
.retake .rt-genov{position:absolute;inset:0;z-index:3;display:flex;align-items:center;justify-content:center;padding:12px;background:color-mix(in srgb,var(--ui-bg-editor) 30%,transparent)}
.retake .rt-genov-card{display:flex;flex-direction:column;align-items:center;gap:10px;max-width:100%;padding:16px 22px;border:1px solid var(--ui-stroke-secondary);border-radius:10px;background:color-mix(in srgb,var(--ui-bg-editor) 92%,transparent);box-shadow:0 10px 30px rgba(0,0,0,.35);text-align:center;font-size:13px;font-weight:600;color:var(--ui-text-primary)}
.retake .rt-genov .rt-spin{width:20px;height:20px}
.retake .rt-genov button{font-weight:400}
.retake .rt-genbar{display:block;width:150px;max-width:60%;height:3px;overflow:hidden;border-radius:2px;background:var(--ui-stroke-secondary)}
.retake .rt-genbar i{display:block;width:40%;height:100%;background:var(--ui-accent);animation:rt-indet 1.6s ease-in-out infinite}
@keyframes rt-indet{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
@media (prefers-reduced-motion:reduce){.retake .rt-genbar i{animation:none;transform:translateX(75%)}}
.retake .rt-minimap{position:absolute;left:8px;bottom:8px;z-index:2;overflow:hidden;border:1px solid var(--ui-stroke-secondary);border-radius:4px;background:var(--ui-bg-editor);cursor:pointer;touch-action:none;line-height:0}
.retake .rt-minimap img{display:block;width:100%;height:100%;opacity:.85}
.retake .rt-minimap img[data-pixels=true]{image-rendering:pixelated}
.retake .rt-minimap i{position:absolute;border:1.5px solid var(--ui-text-primary);border-radius:1px;box-shadow:0 0 0 1px rgba(0,0,0,.45);pointer-events:none}
.retake .rt-mark[data-active=true] .rt-mark-n{opacity:1;box-shadow:0 0 0 2px var(--ui-bg-editor)}
/* One empty/loading/error grammar: a title line, one muted sentence, optional actions. */
.retake .rt-wait{display:flex;flex-direction:column;align-items:center;gap:8px;padding:20px;max-width:100%;text-align:center;color:var(--ui-text-secondary);font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.retake .rt-wait[data-kind=error]{color:var(--ui-text-primary)}
.retake .rt-spin{display:block;width:16px;height:16px;flex:none;border:2px solid var(--ui-stroke-secondary);border-top-color:var(--ui-accent);border-radius:50%;animation:rt-spin .8s linear infinite}
@keyframes rt-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.retake .rt-spin{animation:none}}
.retake .rt-empty{display:flex;flex-direction:column;align-items:center;gap:8px;width:100%;max-width:440px;padding:22px 24px;border:1px dashed var(--ui-stroke-secondary);border-radius:8px;text-align:center;color:var(--ui-text-secondary);font-size:12px;line-height:1.5}
.retake .rt-empty-title{color:var(--ui-text-primary);font-size:13px;font-weight:600}
.retake .rt-empty>.rt-row{justify-content:center;margin-top:4px}
.retake .rt-empty[data-kind=loading]{border-color:transparent}
.retake .rt-empty[data-kind=error]{align-items:flex-start;text-align:left;border-style:solid;border-left:3px solid var(--ui-accent);background:var(--ui-bg-secondary)}
.retake .rt-empty[data-kind=error]>.rt-row{justify-content:flex-start}
.retake .rt-start{display:flex;flex-direction:column;align-items:center;gap:18px;width:100%;max-width:480px;text-align:center}
.retake .rt-start h3{margin:0;font-size:17px;font-weight:600;color:var(--ui-text-primary)}
.retake .rt-choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),220px));gap:12px;width:100%;justify-content:center}
.retake .rt-choice{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:150px;margin:0;padding:12px;border:1px dashed var(--ui-stroke-secondary);border-radius:10px;background:transparent;color:var(--ui-text-primary);font:inherit;font-size:13px;text-align:center;cursor:pointer}
.retake .rt-choice:is(:hover,:focus-visible):not(:disabled):not([data-disabled=true]){border-color:var(--ui-accent);background:color-mix(in srgb,var(--ui-accent) 7%,transparent)}
.retake .rt-choice:disabled,.retake .rt-choice[data-disabled=true]{opacity:.55;cursor:not-allowed}
.retake .rt-choice-drop[data-over=true]{border-style:solid;border-color:var(--ui-accent);background:color-mix(in srgb,var(--ui-accent) 18%,transparent)}
.retake .rt-choice-drop input{position:absolute;left:0;top:0;width:1px;height:1px;margin:0;padding:0;opacity:0;overflow:hidden;clip-path:inset(50%)}
.retake .rt-choice-ic{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--ui-bg-secondary);font-size:18px}
.retake .rt-choice b{font-weight:600}
.retake .rt-choice small{color:var(--ui-text-secondary);font-size:11.5px}
.retake .rt-flow{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:6px 10px;margin:0;padding:0;list-style:none;color:var(--ui-text-secondary);font-size:12px;counter-reset:rt-step}
.retake .rt-flow li{display:flex;align-items:center;gap:6px;counter-increment:rt-step}
.retake .rt-flow li::before{content:counter(rt-step);display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:var(--ui-bg-secondary);color:var(--ui-text-primary);font-size:10.5px}
.retake .rt-flow li:not(:last-child)::after{content:'→';margin-left:4px;opacity:.5}

/* Compare mode: two explicit versions, independent media controls, no winner semantics. */
.retake .rt-cmp{flex:1 1 0;min-height:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:12px}
.retake .rt-work[data-dock=bottom] .rt-cmp{grid-template-columns:minmax(0,1fr);grid-template-rows:repeat(2,minmax(0,1fr))}
.retake .rt-fig{display:flex;flex-direction:column;gap:6px;min-width:0;min-height:0;padding:8px;border:0;border-radius:0;background:color-mix(in srgb,var(--ui-bg-secondary) 45%,transparent)}
.retake .rt-fig-frame{flex:1 1 0;min-height:110px;container-type:size;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:0;background:transparent}
.retake .rt-fit{flex:none;line-height:0}
.retake .rt-fit img,.retake .rt-fit video{display:block;width:auto;height:auto;max-width:100cqw;max-height:100cqh}
/* Images fill their frame (contain), small ones scaled up; --rt-ar is the image's own width/height (unset: natural size).
   The note overlay is positioned in fractions of this same box, so marks stay on the pixels they were drawn on. */
.retake :is(.rt-media,.rt-fit) img{width:min(100cqw,calc(100cqh * var(--rt-ar)))}
.retake :is(.rt-media,.rt-fit) img[data-pixels=true]{image-rendering:pixelated}
.retake .rt-fig figcaption{display:flex;flex-direction:column;gap:2px;min-width:0;padding-top:6px;border-top:1px solid var(--ui-stroke-secondary);font-size:12px}
.retake .rt-fig figcaption .rt-row{flex-wrap:nowrap}
.retake .rt-fig-v{flex:none;font-size:13px}
.retake .rt-fig-name{flex:1 1 auto;color:var(--ui-text-secondary)}
.retake .rt-fig figcaption>.rt-trunc{font-size:11px}
.retake .rt-fig-id{font-size:10px}
.retake .rt-badge{display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:20px;height:20px;padding:0 4px;border-radius:5px;background:color-mix(in srgb,var(--ui-accent) 24%,transparent);color:var(--ui-text-primary);font-size:11px;font-weight:700}
.retake .rt-fig-rel{font-size:11px}
.retake .rt-cmp-tools{display:flex;align-items:center;flex-wrap:nowrap;gap:6px 8px;margin-left:auto;min-width:0}
.retake .rt-cmp-clear{display:inline-flex;align-items:center;gap:5px;flex:none;height:26px;min-height:0;padding:0 8px;font-size:12px}
.retake .rt-cmp-tools>.rt-view{display:inline-flex;flex:none;border:1px solid var(--ui-stroke-secondary);border-radius:6px;overflow:hidden}
.retake .rt-cmp-tools>.rt-view button{min-height:26px}
/* Swipe / Overlay: one box in the first image's shape; both images fit (contain) inside it. */
.retake .rt-cmp-one{flex:1 1 0;min-height:0;display:flex;flex-direction:column;gap:8px;padding:12px}
.retake .rt-cmp-box{flex:1 1 0;min-height:110px;container-type:size;display:flex;align-items:center;justify-content:center;overflow:hidden}
.retake .rt-stack{position:relative;flex:none;width:min(100cqw,calc(100cqh * var(--rt-ar)));aspect-ratio:var(--rt-ar);overflow:hidden;touch-action:none;user-select:none;background:color-mix(in srgb,var(--ui-bg-secondary) 70%,transparent)}
.retake .rt-cmp-one[data-mode=swipe] .rt-stack{cursor:ew-resize}
.retake .rt-stack img{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:contain}
.retake .rt-stack img[data-pixels=true]{image-rendering:pixelated}
.retake .rt-stack-lab{position:absolute;top:6px;z-index:2;padding:1px 6px;border-radius:4px;background:rgba(0,0,0,.6);color:#fff;font-size:11px;font-weight:600;line-height:1.5;pointer-events:none}
.retake .rt-stack-lab[data-side=a]{left:6px}
.retake .rt-stack-lab[data-side=b]{right:6px}
.retake .rt-swipe{position:absolute;top:0;bottom:0;z-index:1;width:2px;margin-left:-1px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.35);cursor:ew-resize}
.retake .rt-swipe::before{content:'';position:absolute;inset:0 -10px}
.retake .rt-swipe b{position:absolute;top:50%;left:50%;display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#fff;color:#111;font-size:12px;line-height:1;transform:translate(-50%,-50%);box-shadow:0 1px 4px rgba(0,0,0,.4)}
.retake .rt-swipe:focus-visible{outline:none}
.retake .rt-swipe:focus-visible b{outline:2px solid var(--ui-accent);outline-offset:2px}
.retake .rt-fade{display:flex;align-items:center;justify-content:center;gap:8px;flex:none;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
.retake .rt-fade input[type=range]{width:min(220px,60%);padding:0;border:0;background:transparent;accent-color:var(--ui-accent)}
.retake .rt-slot{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:110px;padding:16px;border:1px dashed var(--ui-stroke-secondary);border-radius:8px;color:var(--ui-text-secondary);font-size:12px;text-align:center}
.retake .rt-slot .rt-badge{width:24px;height:24px;font-size:12px}
`

const cssStrip = `
/* Filmstrip: versions of the current asset only; scrolls horizontally inside its own box. */
.retake .rt-strip{grid-area:strip;container:rt-strip / inline-size;display:flex;flex-wrap:wrap;align-items:stretch;gap:10px 14px;min-width:0;padding:8px 14px 10px;border-top:1px solid var(--ui-stroke-secondary)}
.retake .rt-strip-main{display:flex;flex-direction:column;gap:6px;flex:999 1 280px;min-width:0}
.retake .rt-strip-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 12px}
.retake .rt-film{list-style:none;display:flex;gap:8px;min-width:0;padding:2px 2px 6px;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;scrollbar-width:thin}
/* Tile: thumbnail, then "v2" + review pill, then source tags, then an A/B chip. */
.retake .rt-frame{position:relative;display:flex;flex-direction:column;gap:5px;flex:none;width:156px;padding:4px 4px 6px;border:0;border-radius:0;background:color-mix(in srgb,var(--ui-bg-secondary) 65%,transparent)}
.retake .rt-frame[data-active=true]{background:color-mix(in srgb,var(--ui-accent) 8%,var(--ui-bg-secondary));box-shadow:inset 0 -2px 0 var(--ui-accent)}
/* Ancestors of the viewed version: accent edge. Other branches: dimmed until hovered or focused. */
.retake .rt-frame[data-line=ancestor]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ui-accent) 60%,transparent)}
.retake .rt-frame[data-line=other]:not(:hover):not(:focus-within){opacity:.5}
/* Ancestry trail under the stage bar: "[thumb] v1 → [thumb] v2 → v4", scrolling inside its own row. */
.retake .rt-trail{flex:none;min-width:0;padding:4px 12px;border-bottom:1px solid var(--ui-stroke-secondary)}
.retake .rt-trail ol{list-style:none;display:flex;align-items:center;gap:2px;margin:0;padding:0;overflow-x:auto;scrollbar-width:thin}
.retake .rt-trail li{display:flex;align-items:center;gap:2px;flex:none}
.retake .rt-trail-arrow{color:var(--ui-text-secondary);font-size:12px}
.retake .rt-trail-btn{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:2px 6px;border:0;border-radius:5px;background:transparent;color:var(--ui-text-secondary);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.retake .rt-trail button.rt-trail-btn{cursor:pointer}
.retake .rt-trail button.rt-trail-btn:hover:not(:disabled){background:color-mix(in srgb,var(--ui-text-primary) 8%,transparent);color:var(--ui-text-primary)}
.retake .rt-trail span.rt-trail-btn{color:var(--ui-text-primary)}
.retake .rt-trail .rt-trail-btn .rt-thumb{flex:none;width:26px;height:18px;aspect-ratio:auto;border-radius:3px;font-size:0}
.retake[data-tight=true] .rt-trail{display:none}
.retake .rt-frame-btn{display:flex;flex-direction:column;gap:5px;width:100%;min-width:0;padding:0;border:0;border-radius:5px;background:transparent;color:inherit;text-align:left}
.retake .rt-frame-text{display:flex;flex-direction:column;gap:3px;min-width:0;padding:0 2px}
.retake .rt-frame-head{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;white-space:nowrap}
.retake .rt-frame-v{flex:none;font-size:15px;line-height:18px;font-weight:700;color:var(--ui-text-primary);font-variant-numeric:tabular-nums}
/* Main / Hidden beside the number; other versions show nothing. */
.retake .rt-frame-head .rt-flag{margin-left:auto;font-size:10px}
/* "N hidden": hidden versions fold into one narrow tile that shows or folds them. */
.retake .rt-hidden-tile{flex:none;display:flex}
.retake .rt-hidden-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;width:76px;min-height:100%;padding:6px 4px;border:1px dashed var(--ui-stroke-secondary);border-radius:6px;background:transparent;color:var(--ui-text-secondary);font-size:11px;line-height:1.2;white-space:nowrap;cursor:pointer}
.retake .rt-hidden-btn:hover:not(:disabled),.retake .rt-hidden-btn[aria-expanded=true]{color:var(--ui-text-primary);border-color:var(--ui-text-secondary)}
/* Source tags: "↳ v1", then "Upload" or the model; the model tag gives way first. */
.retake .rt-tags{display:flex;align-items:center;gap:3px;min-width:0;overflow:hidden}
.retake .rt-tag{display:inline-flex;align-items:center;gap:2px;flex:none;max-width:100%;min-width:0;padding:0 4px;border-radius:4px;background:color-mix(in srgb,var(--ui-text-secondary) 13%,transparent);color:var(--ui-text-secondary);font-size:10px;line-height:16px;white-space:nowrap}
.retake .rt-tag[data-kind=model]{flex:0 1 auto}
.retake .rt-tag>span{min-width:0;overflow:hidden;text-overflow:ellipsis}
.retake .rt-tag svg{width:9px;height:9px}
.retake .rt-frame-file{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--ui-text-secondary)}
.retake .rt-frame[data-attempt] .rt-thumb{border:1px dashed var(--ui-stroke-secondary);background:transparent}
.retake .rt-frame[data-attempt] .rt-astate{font-size:11px;font-weight:600}
.retake .rt-strip-title{display:flex;align-items:baseline;gap:6px;font-size:12px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--ui-text-primary)}
.retake .rt-sec-title{font-size:13px;font-weight:600;color:var(--ui-text-primary);margin:0}
.retake .rt-insp-title{font-size:13px;font-weight:600;margin:0 4px}
.retake .rt-row.rt-end{justify-content:flex-end;gap:8px}
.retake .rt-strip-actions{display:flex;align-items:center;flex-wrap:wrap;justify-content:flex-end;gap:6px;margin-left:auto}
.retake .rt-strip-actions>*{min-height:24px;padding:1px 10px;font-size:12px}
.retake .rt-strip-actions .rt-gen-next{display:inline-flex;align-items:center;gap:6px}
/* Narrow strips: Upload / Generate next version keep their icon; the words stay as the accessible name and tooltip. */
@container rt-strip (max-width:640px){
 .retake .rt-strip-actions :is(.rt-upload,.rt-gen-next)>span{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
 .retake .rt-strip-actions>:is(.rt-upload,.rt-gen-next){padding-left:8px;padding-right:8px}
}
.retake .rt-earlier summary{font-size:12px;color:var(--ui-text-secondary);cursor:pointer}
.retake .rt-earlier-open{padding:6px 0 4px 8px}
.retake .rt-strip-count{font-variant-numeric:tabular-nums;font-weight:500;color:var(--ui-text-secondary)}
.retake .rt-frame[data-mark=hidden] .rt-thumb>img{opacity:.45}
.retake .rt-thumb{display:flex;align-items:center;justify-content:center;gap:4px;width:100%;aspect-ratio:16/10;overflow:hidden;border-radius:5px;background:var(--ui-bg-secondary);color:var(--ui-text-secondary);font-size:10px;line-height:1.2;text-align:center}
/* Thumbnails fill their box (contain), so a tiny image (even 1×1) shows its colour instead of a dot. */
.retake .rt-thumb img{display:block;width:100%;height:100%;object-fit:contain}
/* A/B compare chip: a real checkbox; the chosen slot letter is the visible state. */
.retake label.rt-check{flex-direction:row;align-items:center;align-self:flex-start;gap:4px;height:18px;margin-left:2px;padding:0 6px 0 4px;border:1px solid var(--ui-stroke-secondary);border-radius:999px;font-size:10px;line-height:1;color:var(--ui-text-secondary);cursor:pointer;white-space:nowrap}
.retake label.rt-check{position:relative}
.retake label.rt-check::after{content:'';position:absolute;inset:-4px}
.retake label.rt-check input{position:relative;z-index:1}
.retake label.rt-check:hover{color:var(--ui-text-primary);border-color:var(--ui-text-secondary)}
.retake label.rt-check b{font-size:11px;font-weight:700;color:var(--ui-text-primary)}
.retake label.rt-check input{margin:0;width:12px;height:12px;accent-color:var(--ui-accent)}
.retake label.rt-check:has(input:checked){border-color:var(--ui-accent);background:color-mix(in srgb,var(--ui-accent) 18%,transparent);color:var(--ui-text-primary)}
.retake label.rt-check:has(input:disabled){opacity:.5;cursor:not-allowed}
/* Pressed-state button groups (Compare view, All versions, Lineage tools). */
.retake .rt-view button{min-height:22px;padding:1px 9px;border:0;border-radius:0;background:transparent;color:var(--ui-text-secondary);font-size:12px;white-space:nowrap}
.retake .rt-view button[aria-pressed=true]{background:var(--ui-bg-secondary);color:var(--ui-text-primary);font-weight:600}
.retake .rt-modes{display:inline-flex;flex:none;border:1px solid var(--ui-stroke-secondary);border-radius:6px;overflow:hidden}
.retake .rt-modes button{display:inline-flex;align-items:center;gap:4px;min-height:24px}
.retake .rt-modes button[aria-checked=true]{background:var(--ui-bg-secondary);color:var(--ui-text-primary);font-weight:600}
.retake .rt-modes button[aria-disabled=true]{opacity:.45;cursor:not-allowed}
.retake .rt-modes svg{display:none}
@container rt-root (max-width:600px){.retake .rt-modes svg{display:block}.retake .rt-modes button{padding:1px 8px}.retake .rt-modes button>span,.retake .rt-bar-title>.rt-dl>span{display:none}}
/* Lineage: the whole asset on a pannable, zoomable canvas. Depth is the column, a branch takes a row below. */
.retake .rt-lin{position:relative;flex:1 1 0;min-height:0;overflow:hidden;touch-action:none;user-select:none;cursor:default;background:color-mix(in srgb,var(--ui-bg-secondary) 30%,transparent)}
.retake .rt-lin[data-grab=true],.retake .rt-lin[data-grab=true] button{cursor:grab}
.retake .rt-lin[data-grab=grabbing],.retake .rt-lin[data-grab=grabbing] button{cursor:grabbing}
.retake .rt-lin-canvas{position:absolute;left:0;top:0;transform-origin:0 0}
.retake .rt-lin-canvas>svg{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.retake .rt-lin-edge{fill:none;stroke:var(--ui-stroke-secondary);stroke-width:2}
.retake .rt-lin-edge[data-skip=true]{stroke-dasharray:4 4}
.retake .rt-lin-edge[data-lit=true]{stroke:var(--ui-accent);stroke-width:2.5}
.retake .rt-lin-nodes{list-style:none;margin:0;padding:0}
.retake .rt-lin-node{position:absolute;margin:0}
.retake .rt-lin-node:not([data-path=true]):not(:hover):not(:focus-within){opacity:.55}
.retake .rt-lin-btn{display:flex;flex-direction:column;gap:6px;width:100%;height:100%;padding:8px;border:1px solid var(--ui-stroke-secondary);border-radius:8px;background:var(--ui-bg-editor);color:var(--ui-text-primary);text-align:left;cursor:pointer}
.retake .rt-lin-node[data-path=true] .rt-lin-btn{border-color:color-mix(in srgb,var(--ui-accent) 60%,transparent)}
.retake .rt-lin-node[data-active=true] .rt-lin-btn{border-color:var(--ui-accent);box-shadow:0 0 0 2px var(--ui-accent)}
.retake .rt-lin-btn:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}
.retake .rt-lin-node .rt-lin-btn .rt-thumb{flex:none;width:100%;height:80px;aspect-ratio:auto;border-radius:5px}
.retake .rt-lin-node[data-mark=hidden] .rt-thumb>img{opacity:.45}
.retake .rt-lin-label{display:flex;align-items:center;gap:4px;min-width:0;font-size:12px;line-height:18px;white-space:nowrap}
.retake .rt-lin-label b{flex:none;font-size:13px;font-variant-numeric:tabular-nums}
.retake .rt-lin-label .rt-lin-star{display:inline-flex;flex:none;color:var(--ui-accent)}
.retake .rt-lin-label .rt-lin-eye{display:inline-flex;flex:none;color:var(--ui-text-secondary)}
.retake .rt-lin-model{flex:0 1 auto;min-width:0;margin-left:auto;overflow:hidden;text-overflow:ellipsis;color:var(--ui-text-secondary);font-size:11px}
.retake .rt-lin-zoom button{min-width:28px}
.retake .rt-lin-hidden button{display:inline-flex;align-items:center;gap:4px}
.retake label.rt-upload{position:relative;flex-direction:row;align-items:center;justify-content:center;gap:6px;padding:5px 12px;border:1px solid var(--ui-accent);border-radius:6px;background:color-mix(in srgb,var(--ui-accent) 12%,transparent);color:var(--ui-text-primary);font-size:12px;font-weight:600;white-space:nowrap;cursor:pointer}
.retake label.rt-upload:hover{background:color-mix(in srgb,var(--ui-accent) 20%,transparent)}
.retake label.rt-upload:has(input:focus-visible){outline:2px solid var(--ui-accent);outline-offset:2px}
.retake label.rt-upload[data-disabled=true]{opacity:.55;cursor:progress}
.retake label.rt-upload input{position:absolute;left:0;top:0;width:1px;height:1px;margin:0;padding:0;opacity:0;overflow:hidden;clip-path:inset(50%)}
`

// Generation: sections inside the existing inspector zone, separated by dividers (no cards, no modal).
const cssGenerate = `
.retake .rt-gen{display:flex;flex-direction:column;gap:10px;min-width:0;padding:12px 0;border-top:1px solid var(--ui-stroke-secondary)}
.retake .rt-gen-prompt textarea{min-height:104px}
.retake .rt-shapes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
.retake .rt-shape{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;min-height:0;height:auto;padding:6px 2px 4px;border:1px solid var(--ui-stroke-secondary);border-radius:7px;background:transparent;color:var(--ui-text-secondary);font-size:11px;line-height:1.2;cursor:pointer}
.retake .rt-shape:hover:not(:disabled){color:var(--ui-text-primary)}
.retake .rt-shape:focus-visible{outline:2px solid var(--ui-accent);outline-offset:1px}
.retake .rt-shape[aria-checked=true]{border-color:var(--ui-accent);background:var(--ui-bg-secondary);color:var(--ui-text-primary);font-weight:600}
.retake .rt-shape:disabled{opacity:.5;cursor:not-allowed}
.retake .rt-shape-box{border:1.5px solid currentColor;border-radius:2px}
.retake .rt-shape[aria-checked=true] .rt-shape-box{border-color:var(--ui-accent);background:color-mix(in srgb,var(--ui-accent) 25%,transparent)}
.retake .rt-shape-box[data-shape=landscape]{width:24px;height:15px}
.retake .rt-shape-box[data-shape=square]{width:17px;height:17px}
.retake .rt-shape-box[data-shape=portrait]{width:13px;height:20px}
.retake .rt-model-row{position:relative;gap:8px;min-width:0}
.retake .rt-model-row>.rt-menu-wrap{position:static;min-width:0}
.retake .rt-chip{display:inline-flex;align-items:center;gap:4px;max-width:240px;min-height:0;padding:2px 9px;border:1px solid var(--ui-stroke-secondary);border-radius:999px;background:transparent;color:var(--ui-text-primary);font-size:12px;cursor:pointer}
.retake .rt-chip:hover:not(:disabled),.retake .rt-chip[aria-expanded=true]{background:var(--ui-bg-secondary)}
.retake .rt-chip .rt-caret{font-size:10px;color:var(--ui-text-secondary)}
.retake .rt-model-menu{left:0;right:0;min-width:0;max-height:280px;overflow:auto}
.retake .rt-model-menu [role=menuitemradio]{white-space:normal}
.retake .rt-model-menu [role=menuitemradio]:disabled{color:var(--ui-text-secondary);opacity:.55;cursor:not-allowed;background:transparent}
.retake .rt-menu-group{padding:6px 8px 2px;font-size:10.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ui-text-secondary)}
.retake .rt-confirm-card{display:flex;flex-direction:column;gap:7px;padding:10px;border:1px solid var(--ui-accent);border-radius:8px;background:color-mix(in srgb,var(--ui-accent) 8%,transparent);font-size:12px}
.retake .rt-confirm-card:focus{outline:none}
.retake .rt-confirm-head{display:flex;align-items:center;gap:10px;min-width:0}
.retake .rt-confirm-head>.rt-thumb{flex:none;width:44px;height:30px;aspect-ratio:auto;border-radius:4px}
.retake .rt-confirm-text{min-width:0}
.retake .rt-confirm-title{font-weight:600;font-size:13px}
.retake .rt-quote{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.retake .rt-gen-ref{display:grid;grid-template-columns:72px minmax(0,1fr);gap:4px 10px;align-items:start}
.retake .rt-gen-ref .rt-thumb{height:48px;aspect-ratio:auto}
.retake .rt-gen dl.rt-brief-quote{display:flex;flex-direction:column;gap:6px}
.retake .rt-gen dd{white-space:pre-wrap;line-height:1.45}
.retake .rt-facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;padding:8px 10px;border-radius:6px;background:var(--ui-bg-secondary);font-size:12px;line-height:1.4}
.retake .rt-facts dt{color:var(--ui-text-secondary)}
.retake .rt-how{display:flex;flex-direction:column;gap:8px}
.retake .rt-charge{font-weight:600}
.retake .rt-why{padding:4px 0 4px 10px;box-shadow:inset 2px 0 0 var(--ui-stroke-secondary);color:var(--ui-text-secondary);font-size:12px}
.retake .rt-attempts{list-style:none;padding:0;display:flex;flex-direction:column}
.retake .rt-attempt{display:flex;flex-direction:column;gap:2px;padding:7px 0;border-bottom:1px solid var(--ui-stroke-secondary);font-size:12px}
.retake .rt-astate{font-weight:600}
.retake .rt-attempt[data-state=running] .rt-astate,.retake .rt-frame[data-attempt] .rt-astate{color:var(--ui-accent)}
.retake .rt-insp-title{font-size:13px;font-weight:600}
`

const cssInspector = `
/* One Review inspector. Only its body scrolls; the stage never moves. */
.retake .rt-insp{grid-area:insp;display:flex;flex-direction:column;min-width:0;min-height:0;border-left:1px solid var(--ui-stroke-secondary);background:var(--ui-bg-editor)}
.retake .rt-work[data-dock=bottom] .rt-insp{border-left:0;border-top:1px solid var(--ui-stroke-secondary)}
.retake .rt-insp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;min-height:44px;padding:6px 8px 6px 12px;border-bottom:1px solid var(--ui-stroke-secondary)}
.retake .rt-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:6px 8px}
.retake .rt-insp-body{position:relative;flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:10px 12px 12px}
.retake .rt-insp-tabs{flex:none;align-self:stretch;padding:0 6px;border-bottom:1px solid var(--ui-stroke-secondary)}
.retake .rt-insp-tabs [role=tab]{padding:6px 10px}
.retake .rt-insp-body[hidden]{display:none}
/* History: one fixed-height row per version; lanes take the theme's chart colours. */
.retake .rt-hist{--lane-1:var(--chart-1,#5b9cf0);--lane-2:var(--chart-2,#e08b4a);--lane-3:var(--chart-3,#58b985);--lane-4:var(--chart-4,#c26be0);--lane-5:var(--chart-5,#e0b84a);--lane-6:var(--chart-6,#e0607a);list-style:none;display:flex;flex-direction:column;margin:0 -4px;padding:0}
.retake .rt-hist li{margin:0}
.retake .rt-hist-row{display:flex;align-items:center;gap:8px;width:100%;height:44px;padding:0 6px 0 0;border:0;border-radius:6px;background:transparent;color:var(--ui-text-primary);text-align:left;cursor:pointer}
.retake .rt-hist-row:hover:not(:disabled){background:color-mix(in srgb,var(--ui-text-primary) 6%,transparent)}
.retake .rt-hist-row[data-active=true]{background:color-mix(in srgb,var(--ui-accent) 10%,transparent)}
.retake .rt-hist-graph{flex:none;display:block}
.retake .rt-hist-row .rt-thumb{flex:none;width:44px;height:28px;aspect-ratio:auto;border-radius:4px;font-size:0}
.retake .rt-hist-row[data-mark=hidden] .rt-thumb>img{opacity:.45}
.retake .rt-hist-text{display:flex;flex-direction:column;gap:1px;min-width:0}
.retake .rt-hist-head{display:flex;align-items:center;gap:4px;font-size:13px}
.retake .rt-hist-star{display:inline-flex;color:var(--ui-accent)}
.retake .rt-hist-sub{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
.retake .rt-insp-body>fieldset{display:flex;flex-direction:column;gap:12px;min-width:0;margin:0;padding:0;border:0}
.retake .rt-compose{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px 0;border:0;border-top:1px solid var(--ui-stroke-secondary);border-radius:0;background:transparent}
.retake .rt-insp-body>fieldset>.rt-compose:first-child{border-top:0;padding-top:0}
.retake .rt-next,.retake .rt-request,.retake .rt-newmark{display:flex;flex-direction:column;gap:8px;min-width:0}
.retake .rt-request textarea{min-height:104px}
.retake .rt-next h5.rt-eyebrow{margin:4px 0 0}
.retake .rt-newmark{padding:8px;border:1px solid var(--ui-accent);border-radius:8px}
.retake .rt-newmark-row{display:flex;align-items:flex-start;gap:8px}
.retake .rt-newmark-row>label{flex:1 1 auto;min-width:0}
.retake .rt-newmark-row>.rt-note-n{margin-top:7px}
.retake .rt-details{font-size:12px;color:var(--ui-text-secondary);min-width:0}
.retake .rt-details summary{width:fit-content;max-width:100%;cursor:pointer;border-radius:4px;overflow-wrap:anywhere}
.retake .rt-details summary:hover{color:var(--ui-text-primary)}
.retake .rt-details[open] summary{margin-bottom:6px}
.retake .rt-numbers{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
.retake .rt-numbers input{width:100%}
.retake .rt-identity dl{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:6px;background:var(--ui-bg-secondary)}
.retake .rt-identity-row{display:grid;grid-template-columns:60px minmax(0,1fr);gap:8px;align-items:baseline}
.retake .rt-identity dt{font-size:11px}
.retake .rt-identity p{margin-top:6px}
.retake .rt-notes{list-style:none;padding:0;display:flex;flex-direction:column;gap:2px}
.retake .rt-note{display:flex;align-items:flex-start;gap:8px;width:100%;min-width:0;padding:6px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left}
.retake button.rt-note{cursor:pointer}
.retake .rt-notes li{display:flex;align-items:flex-start;gap:2px}
.retake .rt-note-act{flex:none;margin-top:3px;opacity:0}
.retake .rt-notes li:hover .rt-note-act,.retake .rt-notes li[data-active=true] .rt-note-act,.retake .rt-note-act:focus-visible{opacity:1}
@media (hover:none){.retake .rt-note-act{opacity:1}}
.retake .rt-notes li[data-editing=true]{flex-direction:column;align-items:stretch;gap:4px}
.retake .rt-notes li[data-editing=true]>.rt-note{align-items:flex-start}
.retake .rt-note-edit-acts{display:flex;justify-content:flex-end;gap:6px}
.retake .rt-note-edit-btn{min-height:24px;padding:1px 10px;border:1px solid var(--ui-stroke-secondary);border-radius:6px;background:transparent;color:var(--ui-text-primary);font-size:12px}
.retake .rt-note-edit-btn[data-primary]{border-color:var(--ui-accent);background:var(--ui-accent);color:var(--ui-bg-editor);font-weight:600}
.retake .rt-notes .rt-note-edit{flex:1 1 auto;min-height:56px}
.retake button.rt-note:hover,.retake .rt-notes li[data-active=true] .rt-note{background:var(--ui-bg-secondary)}
.retake .rt-notes li[data-active=true] .rt-note{box-shadow:inset 2px 0 0 var(--ui-accent)}
.retake .rt-note-kind{flex:none;display:flex;align-items:center;gap:2px;min-height:18px;font-size:11px;font-variant-numeric:tabular-nums;color:var(--ui-text-secondary)}
.retake .rt-notes li[data-active=true] .rt-note-kind{color:var(--ui-accent);font-weight:600}
.retake .rt-note-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}
.retake .rt-compose-foot{display:flex;align-items:flex-start;gap:8px}
.retake .rt-compose-foot>.rt-details{flex:1 1 auto;padding-top:5px}
.retake .rt-compose-foot>.rt-row{flex:none;margin-left:auto;flex-wrap:nowrap}
.retake .rt-draw-hint{margin:0}
.retake .rt-drafts{list-style:none;padding:0;display:flex;flex-direction:column;gap:2px}
.retake .rt-draft{display:flex;align-items:baseline;justify-content:space-between;gap:10px;width:100%;padding:6px 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--ui-text-primary);text-align:left}
.retake .rt-draft:hover{background:var(--ui-bg-secondary)}
.retake .rt-draft[aria-pressed=true]{background:var(--ui-bg-secondary);border-color:var(--ui-stroke-secondary)}
.retake .rt-brief{display:flex;flex-direction:column;gap:10px;padding:12px 0;border:0;border-top:1px solid var(--ui-stroke-secondary);border-radius:0;background:transparent}
.retake .rt-brief dl{display:flex;flex-direction:column;gap:10px}
.retake .rt-brief dd{margin-top:2px;line-height:1.5;white-space:pre-wrap}
`

// Short routes need a bounded strip/drawer budget, not another scrolling page.
// The media flexes into the remaining space; only the inspector and filmstrip scroll.
const cssCompact = `
.retake[data-compact=true] .rt-top{padding:4px 8px;gap:2px 10px;min-height:37px}
.retake[data-compact=true] .rt-crumbs{flex:1 1 300px;gap:2px 6px}
.retake[data-compact=true] .rt-crumbs .rt-crumb-p{max-width:14ch}
.retake[data-compact=true] .rt-top .rt-tabs [role=tab]{padding:4px 10px}
.retake[data-compact=true] .rt-bar{padding:0 8px;gap:4px}
.retake[data-compact=true] .rt-bar-title{flex:1 1 120px;flex-wrap:nowrap}
.retake[data-compact=true] .rt-bar-title>.rt-dl{min-height:24px;padding:1px 8px}
.retake[data-compact=true] .rt-stage{min-height:0;padding:6px}
.retake[data-compact=true] .rt-work{grid-template-rows:minmax(0,1fr) 116px}
.retake[data-compact=true] .rt-work[data-dock=bottom]{grid-template-rows:minmax(0,1fr) 116px minmax(110px,min(180px,30%))}
.retake[data-compact=true] .rt-work[data-insp=none]{grid-template-rows:minmax(0,1fr) 116px;grid-template-areas:"main" "strip"}
.retake[data-compact=true] .rt-work[data-dock=bottom] .rt-cmp{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:minmax(0,1fr);gap:6px;padding:6px}
.retake[data-compact=true] .rt-fig{overflow:hidden;padding:5px}
.retake[data-compact=true] .rt-cmp-one{padding:6px;gap:4px}
.retake[data-compact=true] .rt-cmp-box{min-height:0}
.retake[data-compact=true] .rt-fig-frame{min-height:0}
.retake[data-compact=true] .rt-fig figcaption{flex:0 0 auto;max-height:64px;overflow:auto;overscroll-behavior:contain;gap:1px;line-height:1.35}
.retake[data-compact=true] .rt-fig figcaption .rt-row{gap:4px}
.retake[data-compact=true] .rt-fig figcaption .rt-flag{font-size:10px}
.retake[data-compact=true] .rt-fig-id{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.retake[data-compact=true] .rt-strip{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);gap:2px 6px;height:116px;min-height:0;padding:3px 6px 4px}
.retake[data-compact=true] .rt-strip-main{display:contents}
.retake[data-compact=true] .rt-strip-head{grid-column:1;grid-row:1;display:flex;align-items:baseline;line-height:14px}
.retake[data-compact=true] .rt-strip-title{font-size:11px;line-height:14px}
.retake[data-compact=true] .rt-strip-head>:not(h3):not(.rt-strip-actions),.retake[data-compact=true] .rt-strip-of{display:none}

.retake[data-compact=true] .rt-strip-dot{display:none}

.retake[data-compact=true] .rt-strip-main>:not(.rt-strip-head){grid-column:1;grid-row:2;min-height:0}
.retake[data-compact=true] .rt-film{padding:1px 1px 3px;min-height:0}
/* Compact tile: thumb left; v + pill, source tags and the A/B chip stacked right. */
.retake[data-compact=true] .rt-frame{display:block;width:224px;padding:3px 6px 3px 3px}
.retake[data-compact=true] .rt-frame-btn{display:grid;grid-template-columns:64px minmax(0,1fr);align-items:center;gap:7px}
.retake[data-compact=true] .rt-frame-text{gap:2px;padding:0 0 19px}
.retake[data-compact=true] .rt-frame-v{font-size:14px;line-height:17px}
.retake[data-compact=true] .rt-frame-file{font-size:10px}
.retake[data-compact=true] .rt-frame label.rt-check{position:absolute;left:74px;bottom:4px;height:16px;margin:0}
.retake[data-compact=true] .rt-frame[data-attempt] .rt-frame-text{padding-bottom:0}
.retake[data-compact=true] .rt-thumb{height:40px;aspect-ratio:auto}
.retake[data-compact=true] .rt-strip-actions>*{min-height:22px;padding:0 8px;font-size:11px}
.retake[data-compact=true] .rt-insp-head{min-height:0;padding:4px 6px}
.retake[data-compact=true] .rt-insp-tabs [role=tab]{padding:3px 10px}
.retake[data-compact=true] .rt-view button{min-height:20px;padding:0 7px;font-size:11px}
/* Native title/status chrome can leave less than 480px for the route. Keep
   the media usable without hiding the filmstrip, actions or authored drafts. */
.retake[data-tight=true] .rt-work[data-dock=bottom][data-insp=open]{grid-template-rows:minmax(0,1fr) 116px 76px}
.retake[data-tight=true] .rt-bar{padding:0 6px}
.retake[data-tight=true] .rt-bar-title{flex:0 0 auto}
.retake[data-tight=true] .rt-bar-review .rt-bar-title>:not(.rt-dl):not(.rt-menu-wrap):not(.rt-modes){display:none}
@container rt-root (max-width:600px){
 .retake .rt-scope{display:none}
 .retake .rt-bar .rt-bar-title{flex:0 1 auto}
 .retake .rt-cmp-clear>span{display:none}
 .retake .rt-crumbs{width:100%;flex-wrap:nowrap}
 .retake .rt-crumbs>*{flex:none}
 .retake .rt-crumbs .rt-crumb-p{flex:0 1 auto;min-width:3ch;max-width:14ch}
 .retake .rt-crumbs .rt-asset-name{flex:1 1 0;min-width:4ch}
 .retake :is(.rt-assets,.rt-vgrid){--rt-card-min:128px}
 .retake .rt-bar-dim{display:none}
}
`
const css = [cssBase, cssUtility, cssShell, cssStage, cssStrip, cssInspector, cssGenerate, cssCompact].join('\n')

const text = e => e instanceof Error ? e.message : String(e)
// ctx.rest follows the window's active Hermes connection and profile; Retake names them and never moves them by itself.
const NO_CONNECTION = { get: () => null } // older hosts without host.state.connectionId
const connectionNow = () => { try { return host.state.connectionId?.get?.() ?? null } catch { return null } }
const notInstalled = e => /plugin not found/i.test(text(e))
const LAST_SCOPE = 'retake.lastScope' // the last connection + profile where Retake loaded (ids only)
const readLastScope = () => { try { const v = JSON.parse(localStorage.getItem(LAST_SCOPE) || 'null'); return v && typeof v.profile === 'string' ? { connectionId: typeof v.connectionId === 'string' ? v.connectionId : null, profile: v.profile } : null } catch { return null } }
const saveLastScope = v => { try { localStorage.setItem(LAST_SCOPE, JSON.stringify(v)) } catch { /* storage blocked: no switch offer */ } }
const connectionLabel = (id, rows) => id === 'local' ? 'This device' : (Array.isArray(rows) && rows.find(x => x.id === id)?.label) || ''
const scopeLabel = (id, profile, rows) => [connectionLabel(id, rows), profile].filter(Boolean).join(' · ')
const enc = encodeURIComponent
const el = (tag, props, ...children) => children.length ? h(tag, props, ...children.flat()) : h(tag, props)
const btn = (label, onClick, props = {}) => el(Button, { type: 'button', variant: 'outline', size: 'sm', onClick, ...props }, label)
const field = (label, value, onChange, props = {}) => el('label', {}, label, h(Input, { value, onChange: e => onChange(e.target.value), ...props }))

// Presentation helpers. A version is the asset's Main (★, one per asset), Hidden, or neither (no status
// shown). Stored review values are unchanged and mapped here: selected → Main, rejected → Hidden, and
// needs_revision or no review yet → nothing. The review endpoint takes main / hidden / none.
const isMain = v => v?.status === 'selected'
const isHidden = v => v?.status === 'rejected'
// The asset's Main (the last one, should older data hold several), or null.
const pickOf = asset => [...asset.items].reverse().find(isMain) || null
// What stands for the asset (card cover, first version opened): its Main, else the latest shown version.
const faceOf = asset => pickOf(asset) || [...asset.items].reverse().find(v => !isHidden(v)) || asset.items[asset.items.length - 1]
const ICON = {
  edit: 'M2 10l.6-2.4L8.2 2 10 3.8 4.4 9.4zM7.2 3l1.8 1.8',
  selected: 'M2.5 6.3 5 8.7l4.5-5.2', star: 'M6 1.4l1.4 2.9 3.2.5-2.3 2.2.5 3.2L6 8.7l-2.8 1.5.5-3.2-2.3-2.2 3.2-.5z',
  eyeClosed: 'M1.5 5c1.2 1.7 2.7 2.6 4.5 2.6S9.3 6.7 10.5 5M2.9 6.6 2 7.8M6 7.6v1.5M9.1 6.6l.9 1.2', more: 'M1.9 6a1 1 0 1 0 2 0a1 1 0 1 0-2 0M5 6a1 1 0 1 0 2 0a1 1 0 1 0-2 0M8.1 6a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
  upload: 'M6 8.5V2M3.5 4.4 6 2l2.5 2.4M2 10.2h8', download: 'M6 2v6.5M3.5 6.1 6 8.5l2.5-2.4M2 10.2h8', left: 'M7.5 2.5 4 6l3.5 3.5', right: 'M4.5 2.5 8 6l-3.5 3.5',
  down: 'M2.5 4.5 6 8l3.5-3.5', up: 'M2.5 7.5 6 4l3.5 3.5', plus: 'M6 2v8M2 6h8', minus: 'M2 6h8', video: 'M1.5 3.5h6v5h-6zM7.5 5.5l3-1.5v4l-3-1.5',
  spark: 'M6 1.5v3M6 7.5v3M1.5 6h3M7.5 6h3', grid: 'M2 2h3v3H2zM7 2h3v3H7zM2 7h3v3H2zM7 7h3v3H7z', list: 'M2 3h8M2 6h8M2 9h8', panel: 'M1.5 2.5h9v7h-9zM4.5 2.5v7', x: 'M3 3l6 6M9 3 3 9', refresh: 'M10 6a4 4 0 1 1-1.2-2.85M10 1.8v2.6H7.4', review: 'M1.5 2.5h9v7h-9zM1.5 8l3-3 2.5 2.5 1.5-1.5 2 2', compare: 'M1.5 2.5h4v7h-4zM6.5 2.5h4v7h-4z', lineage: 'M3 1.5v9M3 7c0-2 1.5-3 3.5-3H9.5', expand: 'M7 2h3v3M10 2 6.5 5.5M5 10H2V7M2 10l3.5-3.5'
}
const icon = (d, filled) => h('svg', { viewBox: '0 0 12 12', width: 12, height: 12, fill: filled ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' }, h('path', { d }))
// Stage tool glyphs need more detail than the 12px set: 24-unit paths drawn at 14px.
const TOOL_ICON = {
  hand: 'M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15',
  mark: 'M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3M12 9v6M9 12h6'
}
const toolIcon = d => h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' }, h('path', { d }))
// "★ Main" or "Hidden" beside a version's number; nothing for any other version.
const mark = v => isMain(v) ? el('span', { className: 'rt-flag', 'data-mark': 'main' }, icon(ICON.star, true), 'Main')
  : isHidden(v) ? el('span', { className: 'rt-flag', 'data-mark': 'hidden' }, icon(ICON.eyeClosed), 'Hidden') : null
const markText = v => isMain(v) ? 'Main' : isHidden(v) ? 'Hidden' : ''
// One review write: to = 'main' | 'hidden' | 'none'. Setting a Main clears the asset's previous one (server side).
const markJob = (v, to, ordinalOf, versions) => ({ path: `/projects/${enc(v.project_id)}/versions/${enc(v.id)}/review`, body: { status: to }, done: r => {
  const was = (r?.unapproved || []).map(id => ordinalOf(versions.find(x => x.id === id) || {})).filter(Boolean), ord = ordinalOf(v) || v.name
  if (to === 'main' && was.length) return { kind: 'ok', text: `Main is now ${ord} (was ${was.join(', ')}).` }
  // Main and Hidden share one stored review value, so hiding the Main unsets it: say so out loud.
  if (to === 'hidden' && isMain(v)) return { kind: 'ok', text: `${ord} hidden; it is no longer main.` }
  return { kind: 'ok', quiet: true, text: to === 'main' ? `${ord} is main.` : to === 'hidden' ? `${ord} hidden.` : isMain(v) ? `${ord} is no longer main.` : `${ord} shown.` }
} })
const toggleMain = v => isMain(v) ? 'none' : 'main'
const toggleHidden = v => isHidden(v) ? 'none' : 'hidden'
const shortId = id => { const s = String(id); return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s }
const size = n => !Number.isFinite(n) ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
const kind = mime => mime === 'video/mp4' ? 'MP4' : String(mime || '').split('/')[1]?.toUpperCase() || ''
const facts = v => [kind(v.mime), size(v.size), v.width && v.height ? `${v.width}×${v.height}` : '', v.duration != null ? `${Number(v.duration).toFixed(1)}s` : ''].filter(Boolean).join(' · ')
const when = t => { if (!t) return ''; const d = new Date(t); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }
// Ancestry of a version: root first, ending at the version itself (stops at a missing parent or a cycle).
const trailOf = (v, versions) => {
  const byId = new Map(versions.map(x => [x.id, x])), chain = [v], seen = new Set([v.id])
  for (let p = byId.get(v.parent_id); p && !seen.has(p.id); p = byId.get(p.parent_id)) { seen.add(p.id); chain.unshift(p) }
  return chain
}
// How each version of an asset relates to the viewed one: its ancestor, in its own line (descendant), or on another branch.
const lineMap = (v, items) => {
  const rel = new Map(trailOf(v, items).slice(0, -1).map(a => [a.id, 'ancestor'])), kids = new Map()
  for (const x of items) if (x.parent_id) kids.set(x.parent_id, [...(kids.get(x.parent_id) || []), x.id])
  const todo = [v.id]
  rel.set(v.id, 'self')
  while (todo.length) for (const k of kids.get(todo.pop()) || []) if (!rel.has(k)) { rel.set(k, 'line'); todo.push(k) }
  return rel
}
// Git-graph rows for the History list, newest first. A lane holds the id its line is heading for (the parent of
// the last row on it); a row sits on the first lane waiting for it, or opens a lane when none is (a branch tip).
const historyRows = items => {
  const ids = new Set(items.map(v => v.id)), lanes = []
  const rows = [...items].reverse().map(v => {
    const hit = []
    lanes.forEach((x, i) => { if (x === v.id) hit.push(i) })
    const before = lanes.slice()
    let col = hit[0]
    if (col === undefined) { col = lanes.findIndex(x => !x); if (col < 0) col = lanes.length }
    for (const i of hit) lanes[i] = null
    lanes[col] = v.parent_id && v.parent_id !== v.id && ids.has(v.parent_id) ? v.parent_id : null
    return { v, col, hit, before, after: lanes.slice() }
  })
  return { rows, width: Math.max(1, ...rows.map(r => Math.max(r.before.length, r.after.length, r.col + 1))) }
}
const lineage = (v, versions) => { if (!v.parent_id) return 'Original'; const p = versions.find(x => x.id === v.parent_id); return p ? `Revision of ${p.name}` : 'Revision' }
const initials = name => String(name || '').trim().split(/\s+/).slice(0, 2).map(w => [...w][0] || '').join('').toUpperCase() || '?'
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
// Generated or hash-like stored filenames identify nothing to a person: the asset ordinal stands in for them
// on screen. The stored name is unchanged and still used for downloads, details and tooltips.
const hashName = name => /^(generated|image|output|retake)?[-_]?[0-9a-f]{8,}(\.[a-z0-9]{2,4})?$/i.test(String(name || ''))
// Files travel as the documented JSON `body` of ctx.rest (base64); hosts refuse the multipart `upload`
// option on OAuth-gated remotes before sending. FileReader encodes off the JS stack (no argument spread).
const UPLOAD_TIMEOUT_MS = 180000
const fileBase64 = file => new Promise((resolve, reject) => {
  const r = new FileReader()
  r.onerror = () => reject(new Error('Could not read the file.'))
  r.onload = () => { const s = String(r.result || ''), i = s.indexOf(','); i > 0 ? resolve(s.slice(i + 1)) : reject(new Error('Could not read the file.')) }
  r.readAsDataURL(file)
})

// ---- Generation presentation. Attempt states are never shown as Main or Hidden. ----
// Direct route: a confirmed POST reserves an attempt, then POST .../run asks this profile's Retake backend
// to claim it once and call Hermes's configured `image_generate` through stock's tool server. No chat,
// session, focus or command catalog is involved. Retake chooses no provider or model.
const COST_UNKNOWN = 'Cost unknown'
const SCOPE_NOTE = 'Uses Hermes configured image generation; provider account may be charged; cost unknown.'
const COMMAND = 'retake-generate'
const RUN_WAIT_MS = 11 * 60 * 1000 // backend tool timeout is 10 min; after that the record reads unknown/stale
const ASPECTS = [['landscape', 'Landscape'], ['square', 'Square'], ['portrait', 'Portrait']]
const ATTEMPT = { reserved: 'Reserved · not sent yet', running: 'Generating in Hermes…', succeeded: 'Stored as a version', failed: 'Failed · no version', unknown: 'Outcome unknown' }
const ACTIVE_ATTEMPT = s => s === 'running' || s === 'reserved'

// ---- Feedback. In-page toasts for everything; Hermes' own notify only for a generation that settles while
// no Retake page is showing. Routine confirmations (saved, renamed) never reach Hermes.
const TOAST_MS = 5000
let pagesOpen = 0 // mounted Retake pages; a generation settling while one is open reports in-page
let openNext = null // { profile, projectId, versionId } set by a Hermes "View" action, taken by the next page
const following = new Set() // attempt ids read in the background after their page closed
// Hermes palette rows ('switch' focuses the open project in the rail, 'new' opens New project) reach the open page
// here; a request made before any Retake page is mounted waits for the next one.
const pageRequests = { pending: null, pages: new Set() }
const requestPage = kind => {
  if (typeof host?.navigate === 'function') host.navigate('/retake')
  if (pageRequests.pages.size) pageRequests.pages.forEach(fn => fn(kind)); else pageRequests.pending = kind
}
const hermesNotify = n => { try { if (typeof host?.notify === 'function') host.notify(n) } catch { /* no host toast: nothing to do */ } }
// Words for a settled attempt shown outside Retake. `ord` is the version ordinal ('v3') when known.
const awayNote = (a, project, ord, open) => {
  const where = project ? ` in ${project}` : ''
  if (a.state === 'succeeded') return { kind: a.selection_mismatch ? 'warning' : 'success', title: 'Retake',
    message: a.selection_mismatch ? `Generated ${ord || 'a new version'}${where}, but not with the chosen model. Check it before use.` : `Generated ${ord || 'a new version'}${where}.`,
    ...(a.selection_mismatch ? {} : { placement: 'bottom-right' }), ...(open ? { action: { label: 'View', onClick: open } } : {}) }
  return { kind: 'error', title: 'Retake', message: a.state === 'unknown' ? `Generation outcome unknown${where}. It may have been billed.` : `No version created${where}.` }
}
const viewAction = (profile, projectId, versionId) => typeof host?.navigate !== 'function' || !versionId ? null
  : () => { openNext = { profile, projectId, versionId }; host.navigate('/retake') }
// Reads one attempt after its page closed (read-only, never dispatches) and announces it through Hermes once
// it settles, unless a Retake page is open by then or the profile/connection changed.
async function followAway(ctx, profile, epoch, projectId, attemptId) {
  if (following.has(attemptId)) return
  following.add(attemptId)
  const connection = connectionNow()
  const same = () => host.state.profile.get() === profile && gatewayActivationEpoch() === epoch && connectionNow() === connection
  try {
    const until = Date.now() + RUN_WAIT_MS
    let a = null
    while (same() && Date.now() < until && !(a && !ACTIVE_ATTEMPT(a.state))) {
      await new Promise(resolve => setTimeout(resolve, a ? 3000 : 1500))
      try { const r = await ctx.rest(`/projects/${enc(projectId)}/generations/${enc(attemptId)}`); if (r?.attempt?.id === attemptId) a = r.attempt } catch { /* keep reading */ }
    }
    if (!a || ACTIVE_ATTEMPT(a.state) || !same() || pagesOpen > 0) return
    await announceAway(ctx, projectId, a, () => same() && pagesOpen === 0)
  } finally { following.delete(attemptId) }
}
// Names the project and version ordinal (read-only), then hands the settled attempt to Hermes notify.
async function announceAway(ctx, projectId, a, still, open) {
  const profile = host.state.profile.get()
  let project = '', ord = ''
  try {
    const d = await ctx.rest(`/projects/${enc(projectId)}`)
    project = typeof d?.project?.name === 'string' ? d.project.name : ''
    const versions = Array.isArray(d?.versions) ? d.versions : []
    const v = versions.find(x => x.id === a.version_id)
    const i = v ? versions.filter(x => x.asset_id === v.asset_id).indexOf(v) : -1
    if (i >= 0) ord = `v${i + 1}`
  } catch { /* plain wording without names */ }
  if (still()) hermesNotify(awayNote(a, project, ord, a.state === 'succeeded' ? open || viewAction(profile, projectId, a.version_id) : null))
}
// One floating message. Ok ones close after TOAST_MS, held while hovered or focused; errors stay until closed.
function Toast({ toast, onClose, action, children }) {
  const [held, setHeld] = useState(false)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (toast.kind === 'error' || held) return
    const timer = setTimeout(() => close.current(), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast.id, toast.kind, held])
  const error = toast.kind === 'error'
  return el('div', { className: 'rt-toast', 'data-kind': toast.kind, role: error ? 'alert' : 'status', 'aria-live': error ? 'assertive' : 'polite', 'aria-atomic': 'true',
    onMouseEnter: () => setHeld(true), onMouseLeave: e => setHeld(e.currentTarget.contains(document.activeElement)),
    onFocus: () => setHeld(true), onBlur: e => { if (!e.currentTarget.contains(e.relatedTarget)) setHeld(e.currentTarget.matches(':hover')) } },
  el('span', {}, children),
  action ? el('button', { type: 'button', className: 'rt-toast-act', onClick: () => { action.onClick(); onClose() } }, action.label) : null,
  el('button', { type: 'button', className: 'rt-x', 'aria-label': 'Dismiss message', onClick: onClose }, icon(ICON.x)))
}
// Stable per-request nonce (32 lowercase hex): the same confirmed intent never reserves twice.
const requestId = () => (crypto.randomUUID?.() || [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('')).replace(/-/g, '').toLowerCase()
const aspectOf = v => !v?.width || !v?.height ? 'landscape' : v.width > v.height * 1.1 ? 'landscape' : v.height > v.width * 1.1 ? 'portrait' : 'square'
// Only the sanitized stock-route descriptor is accepted; anything else reads as unavailable.
function capabilities(q) {
  const d = q.data
  const s = v => typeof v === 'string' ? v.slice(0, 300) : ''
  const base = { available: false, label: 'Hermes configured image generation', cost: COST_UNKNOWN, note: SCOPE_NOTE, retryNote: '', revision: false, revisionReason: '', reason: '' }
  if (q.error) return { ...base, failed: true, reason: `Generation status unavailable: ${text(q.error)}` }
  if (!d || typeof d !== 'object' || d.route !== 'direct') return { ...base, checking: !!q.isPending, reason: q.isPending ? 'Checking Retake…' : 'This Retake backend does not offer direct generation. Update the Retake plugin.' }
  return { ...base, available: d.available === true, reason: s(d.reason), note: s(d.note) || SCOPE_NOTE, retryNote: s(d.retry_note),
    revision: d.revision?.enabled === true, revisionReason: s(d.revision?.reason) || 'Automatic revision is not available.' }
}
// A card title from a prompt: its first clause without a leading article, at most six words.
const shortTitle = prompt => {
  const words = String(prompt || '').split(/[\n,.;:!?]/)[0].trim().replace(/^(a|an|the)\s+/i, '').split(/\s+/).filter(Boolean)
  const t = words.slice(0, 6).join(' ')
  return t ? `${t[0].toUpperCase()}${t.slice(1)}${words.length > 6 ? '…' : ''}` : 'New asset'
}
const aspectLabel = id => (ASPECTS.find(([x]) => x === id) || ASPECTS[0])[1]
// Aspect as three shape cards: one radio group, arrow keys move and select.
function AspectCards({ value, onChange, compact }) {
  const keys = e => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
    if (!step) return
    e.preventDefault()
    const i = (Math.max(0, ASPECTS.findIndex(([id]) => id === value)) + step + ASPECTS.length) % ASPECTS.length
    onChange(ASPECTS[i][0]); e.currentTarget.querySelectorAll('[role=radio]')[i]?.focus()
  }
  return el('div', { className: compact ? 'rt-shapes rt-seg' : 'rt-shapes', role: 'radiogroup', 'aria-label': 'Aspect', onKeyDown: keys },
    ...ASPECTS.map(([id, label]) => el('button', { key: id, type: 'button', role: 'radio', className: 'rt-shape', 'aria-checked': value === id, tabIndex: value === id ? 0 : -1, onClick: () => onChange(id) },
      el('span', { className: 'rt-shape-box', 'data-shape': id, 'aria-hidden': 'true' }), label)))
}
const genFacts = (gen, extra = [], model) => el('dl', { className: 'rt-facts' }, ...[['Uses', 'Hermes configured image generation (image_generate)'],
  ['Provider/model', model ? `${model.display} · ${modelFacts(model)}` : 'Whatever Hermes is configured to use; the tool’s own report is recorded after'],
  ['Cost', gen.cost || COST_UNKNOWN], ...extra].map(([k, v]) => [el('dt', { key: `${k}-t` }, k), el('dd', { key: `${k}-d` }, v)]))
const routeNote = route => route.ready ? null : el('p', { className: 'rt-why', role: 'status' }, route.reason)
const retryNote = gen => gen.retryNote || 'Retake never retries; the configured tool may still do its own retries or fallback.'
// Shown at the confirm decision point: the charge disclosure is never collapsed.
const chargeLine = gen => el('p', { key: 'charge', className: 'rt-confirm-charge' }, el('b', { className: 'rt-charge' }, `May be charged · ${(gen.cost || COST_UNKNOWN).toLowerCase()}.`), ' Runs once; never retried.')

// Shared wording for an attempt's record: the pending list and the produced version's details.
const reportedOf = a => [a.reported_provider, a.model].filter(Boolean).join(' · ')
const requestedOf = a => a.image_selection?.display ? `${String(a.image_selection.display)} · ${BILLING[a.image_selection.billing] || 'subscription'}` : ''
const CAPS_FAILED = 'Couldn’t check generation'
const MISMATCH = 'Hermes reported a different model or a fallback; not the model you chose.'
// Only attempts that still need the user; a succeeded attempt's record lives in its version's details.
const pendingAttempts = attempts => attempts.filter(a => a.state !== 'succeeded')

function AttemptList({ label, attempts, onCheck, onSend, onCancel, canSend }) {
  const pending = pendingAttempts(attempts)
  if (!pending.length) return null
  return el('div', { className: 'rt-gen' },
    el('h4', { className: 'rt-eyebrow' }, `${label} · ${pending.length}`),
    el('ol', { className: 'rt-attempts', 'aria-label': label }, ...pending.slice(0, 8).map(a => {
      const open = ACTIVE_ATTEMPT(a.state) || a.state === 'unknown'
      const reserved = a.state === 'reserved'
      const reportedBy = reportedOf(a), requested = requestedOf(a)
      return el('li', { key: a.id, className: 'rt-attempt', 'data-state': a.state },
        el('div', { className: 'rt-row rt-between' }, el('span', { className: 'rt-astate' }, ATTEMPT[a.state] || 'Unrecognized state'), el('span', { className: 'rt-id', title: a.id, 'aria-label': `Attempt ${a.id}` }, `Attempt ${shortId(a.id)}`)),
        el('span', { className: 'rt-muted' }, [when(a.created_at), a.aspect_ratio, reportedBy ? `tool reported ${reportedBy} (variant not verified)` : a.model ? `model ${a.model}` : '', a.modality ? `${a.modality} input` : ''].filter(Boolean).join(' · ')),
        requested ? el('span', { className: 'rt-muted' }, `Requested ${requested}`) : null,
        a.selection_mismatch ? el('span', { className: 'rt-why' }, MISMATCH) : null,
        a.error?.message ? el('span', {}, String(a.error.message)) : null,
        open && a.outcome ? el('span', { className: 'rt-muted' }, String(a.outcome)) : null,
        open ? el('div', { className: 'rt-row' },
          reserved && onSend ? btn('Run', () => onSend(a.id), { disabled: !canSend, 'aria-label': `Run reserved attempt ${a.id}`, title: 'Runs this one reserved attempt. Retake refuses if it already ran.' }) : null,
          reserved && onCancel ? btn('Cancel reservation', () => onCancel(a.id), { 'aria-label': `Cancel reserved attempt ${a.id}`, title: 'Releases a reservation Hermes has not run. Nothing was sent.' }) : null,
          open ? btn('Check status', onCheck, { 'aria-label': `Check status of attempt ${a.id}`, title: 'Re-reads Retake’s record. Does not contact Hermes, the tool or the provider and never retries.' }) : null) : null)
    })))
}

// Optional per-request model, from Hermes's own listing for this profile. Absent (older Hermes) => no picker
// at all and the configured-model flow is unchanged. A listed model is not proof the account may run it.
const BILLING = { 'subscription:chatgpt': 'ChatGPT subscription', 'subscription:nous': 'Nous subscription' }
const pickable = (picks, revision) => (picks.supported ? picks.list : []).filter(d => !revision || d.revision)
const chosenOf = (picks, revision, id) => pickable(picks, revision).find(d => d.id === id && d.available !== false) || null
const modelFacts = d => [BILLING[d.billing], 'entitlement and cost unknown', d.available === null ? 'availability checked when it runs' : '', d.variant_enforced ? '' : 'quality is a hint, not guaranteed'].filter(Boolean).join(' · ')
const modelName = d => d ? d.display : 'Hermes default'
// Remembered per profile in the plugin's own storage (ctx.storage, else localStorage); every access is guarded.
// `last` is the last model picked or generated with ('' = Hermes default); `recent` is up to 3 model ids, newest first.
const MODEL_KEY = profile => `retake.models.${profile}`
function loadModels(ctx, profile) {
  let v = null
  try { v = typeof ctx?.storage?.get === 'function' ? ctx.storage.get(MODEL_KEY(profile), null) : JSON.parse(localStorage.getItem(`hermes.plugin.retake.${MODEL_KEY(profile)}`) || 'null') } catch { v = null }
  const recent = Array.isArray(v?.recent) ? [...new Set(v.recent.filter(x => typeof x === 'string' && x))].slice(0, 3) : []
  return { last: typeof v?.last === 'string' ? v.last : '', recent }
}
function saveModels(ctx, profile, v) {
  try { if (typeof ctx?.storage?.set === 'function') ctx.storage.set(MODEL_KEY(profile), v); else localStorage.setItem(`hermes.plugin.retake.${MODEL_KEY(profile)}`, JSON.stringify(v)) } catch { /* not remembered */ }
}
const rememberModel = (m, id) => ({ last: id, recent: id ? [id, ...m.recent.filter(x => x !== id)].slice(0, 3) : m.recent })
// The model that asset's newest generated version asked for (uploads in between are skipped), or null when none was generated.
function assetModelOf(attempts, versions, assetId) {
  const mine = versions.filter(v => v.asset_id === assetId)
  for (let i = mine.length - 1; i >= 0; i--) {
    const a = attempts.find(x => x.state === 'succeeded' && x.version_id === mine[i].id)
    if (a) return typeof a.image_selection?.id === 'string' ? a.image_selection.id : ''
  }
  return null
}
// Compact model chip: a menu button over the same listing. Revisions list edit-capable models only.
function ModelChip({ picks, revision, value, onChange, recent = [], bare }) {
  const [open, setOpen] = useState(false)
  const button = useRef(null), menu = useRef(null)
  // The composer and inspector scroll, so they would clip a menu inside them. The menu is placed against the window
  // instead (fixed), below the chip or above it when there is more room there; scrolling or resizing closes it.
  const [place, setPlace] = useState(null)
  useLayoutEffect(() => {
    if (!open || !button.current || !menu.current) return setPlace(null)
    if (!place) return setPlace({ position: 'fixed', top: 0, left: 0, right: 'auto', visibility: 'hidden' }) // first pass: find where fixed (0,0) lands
    if (place.visibility !== 'hidden') return
    const o = menu.current.getBoundingClientRect(), b = button.current.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight
    const below = vh - b.bottom - 12, above = b.top - 12, want = Math.min(320, menu.current.scrollHeight)
    const up = below < want && above > below, max = Math.max(96, Math.min(320, up ? above : below)), width = Math.min(Math.max(b.width, 240), vw - 16)
    const left = Math.min(Math.max(8, b.left), vw - width - 8), top = up ? b.top - 4 - Math.min(want, max) : b.bottom + 4
    setPlace({ position: 'fixed', top: top - o.top, left: left - o.left, right: 'auto', width, maxHeight: max })
  }, [open, place])
  useEffect(() => {
    if (!open) return
    const off = e => { if (!menu.current?.contains(e.target)) setOpen(false) }
    window.addEventListener('scroll', off, true); window.addEventListener('resize', off)
    return () => { window.removeEventListener('scroll', off, true); window.removeEventListener('resize', off) }
  }, [open])
  const placed = !!place && place.visibility !== 'hidden' // a hidden menu can't take focus
  useEffect(() => { if (open && placed) (menu.current?.querySelector('[aria-checked=true]:not(:disabled)') || menu.current?.querySelector('[role=menuitemradio]:not(:disabled)'))?.focus({ preventScroll: true }) }, [open, placed])
  if (!picks.supported) return null
  const list = pickable(picks, revision)
  const d = chosenOf(picks, revision, value)
  const ids = [...(d ? [d.id] : []), ...recent].filter((id, i, all) => all.indexOf(id) === i && chosenOf(picks, revision, id)).slice(0, 3)
  const recents = ids.map(id => list.find(x => x.id === id))
  const group = billing => list.filter(x => x.billing === billing && !ids.includes(x.id))
  const close = () => { setOpen(false); button.current?.focus() }
  const keys = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return }
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key]
    if (!step && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const items = [...menu.current.querySelectorAll('[role=menuitemradio]:not(:disabled)')]
    const i = items.indexOf(document.activeElement)
    items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + step + items.length) % items.length]?.focus()
  }
  const item = (x, label) => {
    const id = x?.id || '', on = (d?.id || '') === id
    return el('button', { key: id || 'default', type: 'button', role: 'menuitemradio', 'aria-checked': on, disabled: x?.available === false, title: x?.unavailable_reason || undefined,
      onClick: () => { onChange(id); close() } }, el('span', { className: 'rt-mcheck', 'aria-hidden': 'true' }, on ? icon(ICON.selected) : null), label)
  }
  return el('div', { className: 'rt-row rt-model-row' }, bare ? null : el('span', { className: 'rt-muted' }, 'Model'),
    el('span', { className: 'rt-menu-wrap', onKeyDown: open ? keys : undefined, onBlur: e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false) } },
      el('button', { ref: button, type: 'button', className: 'rt-chip', 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-label': `Model: ${modelName(d)}. Change`, title: d ? modelFacts(d) : undefined, onClick: () => setOpen(!open) },
        el('span', { className: 'rt-trunc' }, modelName(d)), el('span', { className: 'rt-caret', 'aria-hidden': 'true' }, icon(ICON.down))),
      open ? el('div', { ref: menu, className: 'rt-menu rt-model-menu', style: place || { visibility: 'hidden' }, role: 'menu', 'aria-label': 'Model' },
        item(null, 'Hermes default'),
        ...(recents.length ? [el('div', { key: 'g-recent', role: 'presentation', className: 'rt-menu-group' }, 'Recent'), ...recents.map(x => item(x, x.display))] : []),
        ...Object.keys(BILLING).filter(b => group(b).length).flatMap(b => [el('div', { key: `g-${b}`, role: 'presentation', className: 'rt-menu-group' }, BILLING[b]),
          ...group(b).map(x => item(x, x.available === false ? `${x.display} · unavailable` : x.display))])) : null))
}

// New-asset generation: a centred dialog over the dimmed page. ⌘/Ctrl+Enter or Generate reserves and runs
// one attempt (the same confirmed request as before); Esc or Cancel closes and keeps the prompt.
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
function NewAssetComposer({ gen, route, prompt, setPrompt, aspect, setAspect, picks, model, setModel, recent, onGenerate, onClose, busy, generating, blocked, attempts, onCheck, onSend, onCancel }) {
  const box = useRef(null)
  useEffect(() => { const t = box.current?.querySelector('textarea'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length) } }, [])
  const chosen = chosenOf(picks, false, model)
  const ready = gen.available && route.ready
  const can = ready && !blocked && !busy && !!prompt.trim()
  const send = () => { if (can) onGenerate({ kind: 'new_asset', prompt: prompt.trim(), aspect, selection: chosen?.id || '' }) }
  const keys = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); if (!e.repeat) send(); return }
    if (e.key !== 'Tab') return
    const f = [...box.current.querySelectorAll('button:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(x => x.offsetParent !== null)
    const at = f.indexOf(document.activeElement)
    if (e.shiftKey ? at <= 0 : at === f.length - 1) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0]?.focus() }
  }
  // A click on the dimmed page closes only an empty composer, so a written prompt is never dismissed by a stray click.
  const downOnBackdrop = useRef(false)
  return el('div', { key: 'composer', className: 'rt-overlay rt-compose-wrap', onPointerDown: e => { downOnBackdrop.current = e.target === e.currentTarget; if (downOnBackdrop.current) e.preventDefault() }, // focus stays in the dialog
    onClick: e => { if (downOnBackdrop.current && e.target === e.currentTarget && !prompt.trim()) onClose(); downOnBackdrop.current = false } },
  el('div', { ref: box, className: 'rt-composer', role: 'dialog', 'aria-modal': 'true', tabIndex: -1, 'aria-label': 'Generate new asset', onKeyDown: keys },
    gen.available ? routeNote(route) : el('p', { className: 'rt-why', role: 'status' }, gen.reason || 'Image generation is not available for this profile.'),
    h(Textarea, { 'aria-label': 'Prompt', value: prompt, placeholder: 'Describe the image', onChange: e => setPrompt(e.target.value) }),
    el('div', { className: 'rt-compose-row' },
      h(AspectCards, { value: aspect, onChange: setAspect, compact: true }),
      h(ModelChip, { picks, revision: false, value: model, recent, onChange: setModel, bare: true }),
      el('span', { className: 'rt-compose-go' }, btn('Cancel', onClose),
        btn(['Generate', el('kbd', { key: 'k', className: 'rt-kbd-hint', 'aria-hidden': 'true' }, MAC ? '⌘↵' : 'Ctrl↵')], send, { variant: undefined, className: 'rt-primary', disabled: !can, 'aria-keyshortcuts': 'Meta+Enter Control+Enter' }))),
    blocked ? el('p', { className: 'rt-why', role: 'status' }, 'Another generation is reserved or running.') : chargeLine(gen),
    h(AttemptList, { label: 'New-asset attempts', attempts, onCheck, onSend, onCancel, canSend: ready && !generating })))
}

// Revision from an explicitly SAVED brief bound to this exact version. Unsaved text is never used.
// Stock image_generate offers plugins no verified image-EDIT contract, so this stays disabled (with the
// reason shown) until the backend reports revision as qualified; saved briefs and manual upload remain.
// Confirm step for ONE saved request on this exact version; it replaces the request area in the sidebar.
// Aspect and model were chosen in the request. Nothing is reserved until "Generate".
function ReviseConfirm({ scope, gen, version, brief: b, title, aspect, model: sel, onBack, generating, blocked, onGenerate }) {
  const box = useRef(null)
  useEffect(() => { box.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); box.current?.focus({ preventScroll: true }) }, [b.id])
  const notes = b.annotations?.length || 0
  return el('section', { className: 'rt-confirm-card', 'aria-label': 'Confirm revision', ref: box, tabIndex: -1 },
    el('div', { className: 'rt-confirm-head' }, h(Thumb, { scope, version }),
      el('div', { className: 'rt-confirm-text' }, el('p', { className: 'rt-confirm-title' }, title),
        el('p', { className: 'rt-muted' }, `${modelName(sel)} · ${aspectLabel(aspect)} · ${plural(notes, 'note')}`))),
    chargeLine(gen),
    blocked && !generating ? el('p', { className: 'rt-why', role: 'status' }, 'Another generation is reserved or running.') : null,
    el('details', { className: 'rt-details' }, el('summary', {}, 'Details'),
      el('div', { className: 'rt-how' },
        el('div', { className: 'rt-gen-ref', role: 'group', 'aria-label': 'Reference and request' },
          h(Thumb, { scope, version }),
          el('div', {}, el('p', {}, 'Reference · this exact version'), el('p', { className: 'rt-muted' }, `${plural(notes, 'note')} included`)),
          el('dl', { className: 'rt-brief-quote', style: { gridColumn: '1 / -1' } },
            el('div', {}, el('dt', { className: 'rt-eyebrow' }, 'Change'), el('dd', {}, b.change)),
            el('div', {}, el('dt', { className: 'rt-eyebrow' }, 'Keep'), el('dd', {}, b.preserve)))),
        el('p', { className: 'rt-why' }, 'Reference-guided, not masked editing: noted regions are sent as text guidance, so other areas may still change.'),
        genFacts(gen, [['Creates', 'Next version of this asset · parent kept']], sel),
        el('p', { className: 'rt-muted' }, gen.note || SCOPE_NOTE), el('p', { className: 'rt-muted' }, retryNote(gen)))),
    el('div', { className: 'rt-row rt-end' },
      btn('Back', onBack, { disabled: !!generating }),
      btn(generating ? 'Generating…' : 'Generate', () => onGenerate({ kind: 'revision', parentId: version.id, briefId: b.id, aspect, selection: sel?.id || '' }), { variant: undefined, className: 'rt-primary', disabled: blocked || !!generating })))
}

// Assets are the exact stored asset_id groups. The label is the asset's original (root) filename,
// a display convenience only; it is not stored metadata and never rewrites anything.
function groupAssets(versions, names = {}) {
  const groups = new Map()
  for (const v of versions) { if (!groups.has(v.asset_id)) groups.set(v.asset_id, []); groups.get(v.asset_id).push(v) }
  const assets = [...groups].map(([id, items]) => ({ id, items, root: items.find(v => !v.parent_id) || items[0] }))
  const seen = new Map()
  for (const a of assets) seen.set(a.root.name, (seen.get(a.root.name) || 0) + 1)
  assets.forEach((a, i) => { a.n = i + 1; a.named = typeof names[a.id] === 'string' && !!names[a.id]; a.label = a.named ? names[a.id] : hashName(a.root.name) ? `Asset ${a.n}` : seen.get(a.root.name) > 1 ? `${a.root.name} · ${shortId(a.id)}` : a.root.name })
  return assets
}

// Project search: local, case-insensitive, every word must appear in one version's text: its asset name, its
// file name, its saved notes or the revision requests written on it. Returns the matching version ids, or null.
function searchProject(query, assets, annotations = [], briefs = []) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return null
  const text = new Map()
  for (const a of assets) for (const v of a.items) text.set(v.id, [a.label, v.name])
  for (const n of Array.isArray(annotations) ? annotations : []) text.get(n?.version_id)?.push(String(n.note || ''))
  for (const b of Array.isArray(briefs) ? briefs : []) text.get(b?.version_id)?.push(String(b.change || ''), String(b.preserve || ''))
  const hits = new Set()
  for (const [id, parts] of text) { const hay = parts.join('\n').toLowerCase(); if (words.every(w => hay.includes(w))) hits.add(id) }
  return hits
}

// Lineage layout: depth is the column; a first child stays on its parent's row and each later sibling (a branch)
// starts the next free row below. Items arrive in creation order, so rows read left→right by time. `up` gives the
// shown version a version's line comes from (a hidden one in between is skipped), or null for a root.
const LIN_W = 136, LIN_H = 120, LIN_GX = 56, LIN_GY = 24, LIN_PAD = 24, LIN_ZMIN = 0.25, LIN_ZMAX = 2.5
function lineageLayout(items, up) {
  const ids = new Set(items.map(v => v.id)), kids = new Map(), pos = new Map(), parent = new Map()
  for (const v of items) { const p = up(v); if (p && p !== v.id && ids.has(p)) parent.set(v.id, p) }
  for (const v of items) if (parent.has(v.id)) { const p = parent.get(v.id); if (!kids.has(p)) kids.set(p, []); kids.get(p).push(v) }
  let rows = 0, cols = 0
  const place = (v, col) => {
    pos.set(v.id, { col, row: rows }); cols = Math.max(cols, col + 1)
    const next = (kids.get(v.id) || []).filter(k => !pos.has(k.id))
    if (!next.length) rows++
    for (const k of next) if (!pos.has(k.id)) place(k, col + 1)
  }
  for (const v of items) if (!pos.has(v.id) && !parent.has(v.id)) place(v, 0)
  for (const v of items) if (!pos.has(v.id)) place(v, 0) // malformed lineage (a cycle) is still shown
  const edges = items.filter(v => parent.has(v.id) && pos.get(v.id).col === pos.get(parent.get(v.id)).col + 1).map(v => [parent.get(v.id), v.id])
  return { pos, edges, w: Math.max(0, cols * (LIN_W + LIN_GX) - LIN_GX), h: Math.max(0, rows * (LIN_H + LIN_GY) - LIN_GY) }
}
// Short name of the model the tool REPORTED (never the one requested): its listed display without the
// parenthetical, else the last segment of the reported model id.
const reportedShort = (a, list) => {
  const m = typeof a?.model === 'string' ? a.model.trim() : ''
  if (!m) return ''
  const d = list.find(x => x.model === m)
  return (d ? d.display.replace(/\s*\(.*\)\s*$/, '') : m.split('/').pop()).slice(0, 40)
}

// Page-level keys (←/→ versions, Escape) never act while the user is typing.
const typingIn = t => !!t?.closest?.('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=button]),textarea,select,[contenteditable]:not([contenteditable=false])')

// Arrow/Home/End keyboard support shared by every tablist.
const tabKeys = e => {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
  if (!step && e.key !== 'Home' && e.key !== 'End') return
  const tabs = [...e.currentTarget.closest('[role=tablist]').querySelectorAll('[role=tab]:not(:disabled)')]
  const i = tabs.indexOf(e.currentTarget)
  const next = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1] : tabs[(i + step + tabs.length) % tabs.length]
  if (!next) return
  e.preventDefault(); next.focus(); next.click()
}

// Full original media through bounded public ctx.rest JSON; used only for the stage and Compare.
// The bounded /media read, shared (one query key) by the stage, Compare, the full view and Download.
const useMedia = (scope, version) => useQuery({ queryKey: [...scope.key, 'media', version.id], queryFn: () => scope.read(`/projects/${enc(version.project_id)}/versions/${enc(version.id)}/media`), staleTime: 60000, retry: false })
const mediaOk = p => !!p && MEDIA_MIME.test(p.mime) && typeof p.base64 === 'string' && p.base64.length <= 46000000
const mediaSrc = p => `data:${p.mime};base64,${p.base64}`
const mediaState = media => media.isPending || media.isLoading ? el('div', { className: 'rt-wait', 'aria-busy': 'true' }, el('span', { className: 'rt-spin', 'aria-hidden': 'true' }), 'Loading media…')
  : media.error ? el('div', { className: 'rt-wait', 'data-kind': 'error', role: 'status' }, el('strong', {}, 'Media unavailable'), el('span', { className: 'rt-muted' }, text(media.error)), btn('Reload media', () => media.refetch?.()))
  : !mediaOk(media.data) ? el('div', { className: 'rt-wait', 'data-kind': 'error', role: 'status' }, el('strong', {}, 'Unsupported media'), el('span', { className: 'rt-muted' }, 'Retake shows PNG, JPEG, WebP and MP4 originals.'))
  : null

// Stage zoom is relative to Fit (1 = the whole image fits the stage), clamped Fit..800%.
const ZOOM_MAX = 8
const ZOOM_STEPS = [1, 1.5, 2, 3, 4, 6, 8]
const clampZoom = z => Math.max(1, Math.min(ZOOM_MAX, Number.isFinite(z) ? z : 1))
// Keys the stage takes (Space, + − 0) are left to any focused control or open menu/dialog.
const OWNS_KEYS = 'button,a[href],input,textarea,select,summary,label,video,audio,[role=slider],[role=tab],[role=radio],[role=menuitem],[role=menuitemradio],[contenteditable]:not([contenteditable=false])'
// Stage tool: Mark (drag draws a note box) or Hand (drag pans). Starts on Mark; the last choice holds for the session.
const TOOL_KEY = 'hermes.plugin.retake.stageTool'
let lastTool = null
const loadTool = () => {
  if (!lastTool) { try { lastTool = sessionStorage.getItem(TOOL_KEY) } catch { /* not remembered */ } }
  return lastTool === 'hand' ? 'hand' : 'mark'
}
const toolListeners = new Set()
const saveTool = t => { lastTool = t; try { sessionStorage.setItem(TOOL_KEY, t) } catch { /* not remembered */ } toolListeners.forEach(f => f(loadTool())) }
// The stage and the notes list read one shared tool, so the draw hint follows the toggle.
const useTool = () => {
  const [tool, set] = useState(loadTool)
  useEffect(() => { toolListeners.add(set); set(loadTool()); return () => { toolListeners.delete(set) } }, [])
  return tool
}
const TOOL_KEYS = { v: 'hand', h: 'hand', m: 'mark' }
const stageKeysFree = e => !e.defaultPrevented && !e.altKey && !e.ctrlKey && !e.metaKey && !typingIn(e.target) && !e.target?.closest?.(OWNS_KEYS) && !document.querySelector('.retake [role=menu], .retake .rt-overlay')

function Media({ scope, version, variant = 'stage', region, saved = false, marks = [], draftN, onRegion, onTime, onExpand }) {
  const [drag, setDrag] = useState(null)
  // The image's own pixel size (stored dimensions until it decodes), so it can be scaled to fit the frame.
  const [natural, setNatural] = useState(version.width > 0 && version.height > 0 ? { w: version.width, h: version.height } : null)
  const start = useRef(null)
  const media = useMedia(scope, version)
  const stage = variant === 'stage'
  const image = mediaOk(media.data) && media.data.mime.startsWith('image/')
  const zoomable = stage && image
  // Zoom: one transform on the media box (translate from the centred Fit position, then scale). Marks and the
  // drawn box are fractions of that same box, so they stay on their pixels and drag → fractions is unchanged.
  const [view, setView] = useState({ z: 1, x: 0, y: 0 })
  const [grab, setGrab] = useState(false) // Space is held: drag pans instead of drawing
  const tool = useTool()
  const setTool = saveTool
  const [panning, setPanning] = useState(false)
  const viewRef = useRef(view); viewRef.current = view
  const frame = useRef(null), boxRef = useRef(null)
  const space = useRef({ down: false, panned: false }), pan = useRef(null)
  const expand = useRef(onExpand); expand.current = onExpand
  const clampView = v => {
    const f = frame.current, b = boxRef.current, z = clampZoom(v.z)
    if (!f || !b) return { z, x: 0, y: 0 }
    const mx = Math.max(0, (b.offsetWidth * z - f.clientWidth) / 2), my = Math.max(0, (b.offsetHeight * z - f.clientHeight) / 2)
    return { z, x: Math.max(-mx, Math.min(mx, v.x)), y: Math.max(-my, Math.min(my, v.y)) }
  }
  // Zoom keeping the point `at` (px from the frame centre) still under the cursor.
  const zoomTo = (z, at = { x: 0, y: 0 }) => setView(v => { const nz = clampZoom(z), k = nz / v.z; return clampView({ z: nz, x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k }) })
  const zoomStep = dir => { const z = viewRef.current.z; zoomTo(dir > 0 ? ZOOM_STEPS.find(s => s > z + 1e-3) ?? ZOOM_MAX : [...ZOOM_STEPS].reverse().find(s => s < z - 1e-3) ?? 1) }
  const fit = () => setView({ z: 1, x: 0, y: 0 })
  const fromCentre = e => { const r = frame.current.getBoundingClientRect(); return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 } }
  useEffect(() => {
    const node = frame.current
    if (!zoomable || !node) return
    // Ctrl/Cmd+wheel and trackpad pinch (wheel + ctrlKey) zoom at the cursor; plain wheel pans once zoomed.
    const wheel = e => {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomTo(viewRef.current.z * Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * .01), fromCentre(e)); return }
      if (viewRef.current.z > 1) { e.preventDefault(); setView(v => clampView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY })) }
    }
    node.addEventListener('wheel', wheel, { passive: false })
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => setView(v => v.z === 1 ? v : clampView(v))) : null
    resized?.observe(node)
    return () => { node.removeEventListener('wheel', wheel); resized?.disconnect() }
  }, [zoomable])
  // Space: held + drag pans; pressed and released without a drag opens the full view. + / − / 0 zoom and
  // V or H (Hand) / M (Mark) pick the drag tool (images).
  useEffect(() => {
    if (!stage || !mediaOk(media.data)) return
    const release = () => { space.current = { down: false, panned: false }; setGrab(false) }
    const down = e => {
      if (!stageKeysFree(e)) return
      if (e.key === ' ') { e.preventDefault(); if (!e.repeat && !space.current.down) { space.current = { down: true, panned: false }; setGrab(true) } return }
      if (!zoomable) return
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomStep(1) }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomStep(-1) }
      else if (e.key === '0') { e.preventDefault(); fit() }
      else if (!e.shiftKey && TOOL_KEYS[e.key.toLowerCase()]) { e.preventDefault(); setTool(TOOL_KEYS[e.key.toLowerCase()]) }
    }
    const up = e => {
      if (e.key !== ' ' || !space.current.down) return
      const panned = space.current.panned || !!pan.current
      release()
      if (!panned && stageKeysFree(e)) { e.preventDefault(); expand.current?.() }
    }
    document.addEventListener('keydown', down); document.addEventListener('keyup', up); window.addEventListener('blur', release)
    return () => { document.removeEventListener('keydown', down); document.removeEventListener('keyup', up); window.removeEventListener('blur', release) }
  }, [stage, zoomable, !!media.data])
  const loading = mediaState(media)
  if (loading) return loading
  const payload = media.data
  const src = mediaSrc(payload)
  const draw = stage && image
  const hand = zoomable && tool === 'hand'
  const point = e => { const r = e.currentTarget.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) } }
  const box = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) })
  const chosen = drag || region
  const zoomed = zoomable && view.z > 1
  const content = el('div', { ref: boxRef, className: stage ? 'rt-media' : 'rt-fit', 'data-draw': draw && !hand ? 'true' : undefined,
    style: zoomable ? { '--rt-z': view.z, transform: zoomed || view.x || view.y ? `translate(${view.x}px, ${view.y}px) scale(${view.z})` : undefined } : undefined,
    onPointerDown: draw ? e => { if (e.button !== 0 || space.current.down || hand) return; start.current = point(e); e.currentTarget.setPointerCapture(e.pointerId) } : undefined,
    onPointerMove: draw ? e => { if (start.current) setDrag(box(start.current, point(e))) } : undefined,
    onPointerUp: draw ? e => { if (!start.current) return; const b = box(start.current, point(e)); start.current = null; setDrag(null); if (b.width > .005 && b.height > .005) onRegion(b) } : undefined,
    onPointerCancel: draw ? () => { start.current = null; setDrag(null) } : undefined
  }, image ? h('img', { src, alt: version.name, draggable: false, 'data-pixels': natural && Math.max(natural.w, natural.h) <= 64 ? 'true' : undefined,
    style: natural ? { '--rt-ar': natural.w / natural.h } : undefined,
    onLoad: e => { const w = e.currentTarget.naturalWidth, ht = e.currentTarget.naturalHeight; if (w > 0 && ht > 0 && (w !== natural?.w || ht !== natural?.h)) setNatural({ w, h: ht }) } }) : h('video', { src, controls: true, preload: 'metadata', 'aria-label': version.name, onTimeUpdate: stage ? e => onTime?.(e.currentTarget.currentTime) : undefined }),
  // Every saved region note of this version, numbered as in the Notes list. Outlines only: no fill, no masking.
  ...(draw ? marks.map(m => h('div', { key: m.id, className: 'rt-mark', 'data-active': m.active ? 'true' : undefined, 'aria-hidden': 'true', style: { left: `${m.region.x * 100}%`, top: `${m.region.y * 100}%`, width: `${m.region.width * 100}%`, height: `${m.region.height * 100}%` } }, h('span', { className: 'rt-mark-n' }, m.n))) : []),
  draw && chosen ? h('div', { className: 'rt-region', 'data-saved': saved && !drag ? 'true' : undefined, style: { left: `${chosen.x * 100}%`, top: `${chosen.y * 100}%`, width: `${chosen.width * 100}%`, height: `${chosen.height * 100}%` } },
    // The box being drawn or not yet added carries the number its note form shows; a saved note's marker already has one.
    draftN && (drag || !saved) ? h('span', { className: 'rt-mark-n', 'aria-hidden': 'true' }, draftN) : null) : null)
  if (!stage) return content
  // Minimap (zoomed only): the visible part of the image, in fractions of it; click or drag to move there.
  const f = frame.current, b = boxRef.current
  let mm = null
  if (zoomed && f && b && b.offsetWidth && b.offsetHeight) {
    const W = b.offsetWidth, H = b.offsetHeight, at = (s, p, size) => Math.max(0, Math.min(1, (s - p) / view.z / size + .5))
    const w = Math.min(96, 72 * W / H)
    mm = { l: at(-f.clientWidth / 2, view.x, W), r: at(f.clientWidth / 2, view.x, W), t: at(-f.clientHeight / 2, view.y, H), b: at(f.clientHeight / 2, view.y, H), w, h: w * H / W }
  }
  const centreOn = e => {
    const r = e.currentTarget.getBoundingClientRect(), bx = boxRef.current
    if (!bx || !r.width || !r.height) return
    const fx = (e.clientX - r.left) / r.width - .5, fy = (e.clientY - r.top) / r.height - .5
    setView(v => clampView({ ...v, x: -fx * bx.offsetWidth * v.z, y: -fy * bx.offsetHeight * v.z }))
  }
  const minimap = mm ? el('div', { className: 'rt-minimap', 'aria-hidden': 'true', style: { width: mm.w, height: mm.h },
    onPointerDown: e => { if (e.button !== 0) return; e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); centreOn(e) },
    onPointerMove: e => { if (e.currentTarget.hasPointerCapture?.(e.pointerId)) centreOn(e) } },
    h('img', { src, alt: '', draggable: false, 'data-pixels': natural && Math.max(natural.w, natural.h) <= 64 ? 'true' : undefined }),
    h('i', { style: { left: `${mm.l * 100}%`, top: `${mm.t * 100}%`, width: `${(mm.r - mm.l) * 100}%`, height: `${(mm.b - mm.t) * 100}%` } })) : null
  const bar = el('div', { className: 'rt-zoombar', role: 'group', 'aria-label': 'Zoom', 'data-video': image ? undefined : 'true' },
    image ? [
      el('span', { key: 'tools', className: 'rt-tools', role: 'group', 'aria-label': 'Tool' },
        [['hand', 'Hand', 'H'], ['mark', 'Mark', 'M']].map(([id, label, k]) => el('button', { key: id, type: 'button', 'aria-label': label, title: `${label} (${k})`,
          'aria-pressed': tool === id ? 'true' : 'false', onClick: () => setTool(id) }, toolIcon(TOOL_ICON[id])))),
      el('button', { key: 'out', type: 'button', 'aria-label': 'Zoom out', disabled: view.z <= 1, onClick: () => zoomStep(-1) }, icon(ICON.minus)),
      el('button', { key: 'fit', type: 'button', className: 'rt-zoom-level', onClick: fit }, zoomed ? `${Math.round(view.z * 100)}%` : 'Fit'),
      el('button', { key: 'in', type: 'button', 'aria-label': 'Zoom in', disabled: view.z >= ZOOM_MAX, onClick: () => zoomStep(1) }, icon(ICON.plus))] : null,
    onExpand ? el('button', { type: 'button', className: 'rt-zoom-full', 'aria-label': 'Full view', onClick: () => onExpand() }, icon(ICON.expand)) : null)
  // Hand drag, Space+drag or middle-button drag pans; with Mark a plain drag on the image draws a note box.
  const grabbing = panning ? 'grabbing' : (grab || (hand && zoomed)) ? 'true' : undefined
  return el('div', { ref: frame, className: 'rt-zoom', 'data-zoomed': zoomed ? 'true' : undefined, 'data-tool': zoomable ? tool : undefined, 'data-grab': zoomable ? grabbing : undefined,
    onPointerDown: e => {
      if (!zoomable || (!space.current.down && !(hand && zoomed && e.button === 0) && e.button !== 1) || e.target.closest?.('.rt-zoombar,.rt-minimap')) return
      e.preventDefault(); if (space.current.down) space.current.panned = true
      pan.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: viewRef.current.x, y: viewRef.current.y }
      e.currentTarget.setPointerCapture(e.pointerId); setPanning(true)
    },
    onPointerMove: e => { const p = pan.current; if (p && p.id === e.pointerId) setView(v => clampView({ ...v, x: p.x + e.clientX - p.sx, y: p.y + e.clientY - p.sy })) },
    onPointerUp: e => { if (pan.current?.id === e.pointerId) { pan.current = null; setPanning(false) } },
    onPointerCancel: () => { pan.current = null; setPanning(false) },
    // On the frame, not the image: a pan's pointer capture makes the frame the click target.
    onDoubleClick: e => { if (zoomable && !e.target.closest?.('.rt-zoombar,.rt-minimap')) expand.current?.() } },
    content, minimap, bar)
}

// Download the exact stored original of ONE version, from the same bounded /media read the stage uses
// (shared query key, so no extra request in the host). Never the thumbnail, never another version.
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4' }
const downloadName = (version, mime) => {
  const name = String(version.name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, '').trim()
  return name || `retake-${String(version.id).slice(0, 8)}.${EXT[mime] || 'bin'}`
}
function Download({ scope, version, compact = false }) {
  const media = useMedia(scope, version)
  const p = media.data
  const ok = !!p && MEDIA_MIME.test(p.mime) && typeof p.base64 === 'string'
  const save = () => {
    if (!ok || !scope.current()) return
    try {
      const raw = atob(p.base64), bytes = new Uint8Array(raw.length)
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
      const url = URL.createObjectURL(new Blob([bytes], { type: p.mime }))
      const a = document.createElement('a')
      a.href = url; a.download = downloadName(version, p.mime); a.rel = 'noopener'; a.style.display = 'none'
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 30000)
    } catch (e) { host.notify({ kind: 'error', message: `Download failed: ${text(e)}` }) }
  }
  const pending = media.isPending || media.isLoading
  return el('button', { type: 'button', className: compact ? 'rt-dl rt-dl-sm' : 'rt-dl', disabled: !ok, onClick: save, 'aria-label': `Download ${version.name}`,
    title: ok ? `Download the original file · ${downloadName(version, p.mime)}` : pending ? 'Loading the original…' : 'Original unavailable' }, icon(ICON.download), el('span', {}, 'Download'))
}

// Bounded PNG thumbnail (backend-limited to 240×180, 256 KiB). Video gets an honest glyph, never a frame grab.
function Thumb({ scope, version, className = 'rt-thumb', fallback }) {
  const video = version.mime === 'video/mp4'
  const thumb = useQuery({ queryKey: [...scope.key, 'thumb', version.project_id, version.id], queryFn: () => scope.read(`/projects/${enc(version.project_id)}/versions/${enc(version.id)}/thumbnail`), enabled: !video, staleTime: Infinity, retry: false })
  const t = thumb.data
  const ok = !video && t && t.kind === 'image' && t.mime === 'image/png' && typeof t.base64 === 'string' && t.base64.length <= THUMB_B64_LIMIT
  const content = ok ? h('img', { src: `data:image/png;base64,${t.base64}`, alt: '', draggable: false })
    : video ? [icon(ICON.video), fallback ?? 'Video']
    : fallback ?? (thumb.error ? 'No preview' : '')
  return el('span', { className, 'data-kind': ok ? 'image' : video ? 'video' : 'none', 'aria-hidden': 'true' }, content)
}

// "v1 → v2 → v4": the viewed version's ancestry, each earlier step opens that version. Hidden without a parent.
function Trail({ scope, chain, ordinalOf, onOpen, busy }) {
  if (chain.length < 2) return null
  return el('nav', { className: 'rt-trail', 'aria-label': 'Version trail' }, el('ol', {}, ...chain.map((v, i) => {
    const last = i === chain.length - 1, label = ordinalOf(v) || v.name
    return el('li', { key: v.id }, i ? el('span', { className: 'rt-trail-arrow', 'aria-hidden': 'true' }, icon(ICON.right)) : null,
      last ? el('span', { className: 'rt-trail-btn', 'aria-current': 'true' }, h(Thumb, { scope, version: v }), label)
        : el('button', { type: 'button', className: 'rt-trail-btn', disabled: busy, title: v.name, onClick: () => onOpen(v.id) }, h(Thumb, { scope, version: v }), label))
  })))
}

// History tab: every version of the asset, newest first, on a git-style graph of its branches.
const LANE_Y = 22, laneX = i => 9 + 14 * i
function History({ scope, items, current, ordinalOf, originOf, onOpen, busy }) {
  const { rows, width } = historyRows(items), w = laneX(width - 1) + 9
  const keys = e => {
    const move = { ArrowDown: 1, ArrowUp: -1 }[e.key]
    if (!move || e.altKey || e.ctrlKey || e.metaKey) return
    const all = [...e.currentTarget.querySelectorAll('button:not(:disabled)')], i = all.indexOf(e.target)
    if (i < 0) return
    e.preventDefault(); all[(i + move + all.length) % all.length]?.focus()
  }
  const color = i => `var(--lane-${i % 6 + 1})`
  return el('ol', { className: 'rt-hist', 'aria-label': 'Version history', onKeyDown: keys }, ...rows.map(({ v, col, hit, before, after }) => {
    const o = originOf(v), from = o.tags.find(t => t.kind === 'parent'), src = o.tags.find(t => t.kind !== 'parent')
    const sub = [from ? `from ${from.text.replace('↳ ', '')}` : '', src ? (src.kind === 'upload' ? 'upload' : src.text) : ''].filter(Boolean).join(' · ')
    const line = (i, d) => h('path', { key: `${i}${d}`, d, stroke: color(i), strokeWidth: 2, fill: 'none', strokeLinecap: 'round' })
    const lines = [
      ...before.flatMap((x, i) => x && !hit.includes(i) ? [line(i, `M${laneX(i)} 0V44`)] : []),
      ...hit.map(i => line(i, i === col ? `M${laneX(i)} 0V${LANE_Y}` : `M${laneX(i)} 0C${laneX(i)} 14 ${laneX(col)} 8 ${laneX(col)} ${LANE_Y}`)),
      ...(after[col] ? [line(col, `M${laneX(col)} ${LANE_Y}V44`)] : [])]
    const active = v.id === current
    return el('li', { key: v.id },
      el('button', { type: 'button', className: 'rt-hist-row', 'data-active': active ? 'true' : undefined, 'data-lane': col, 'data-mark': isMain(v) ? 'main' : isHidden(v) ? 'hidden' : undefined,
        disabled: busy, 'aria-current': active ? 'true' : undefined, title: [v.name, markText(v)].filter(Boolean).join(' · '), onClick: () => onOpen(v.id) },
        h('svg', { className: 'rt-hist-graph', width: w, height: 44, viewBox: `0 0 ${w} 44`, 'aria-hidden': 'true' }, ...lines,
          h('circle', { cx: laneX(col), cy: LANE_Y, r: active ? 5.5 : 4, fill: color(col), stroke: active ? 'var(--ui-text-primary)' : 'none', strokeWidth: 1.5 })),
        h(Thumb, { scope, version: v }),
        el('span', { className: 'rt-hist-text' },
          el('span', { className: 'rt-hist-head' }, el('b', {}, ordinalOf(v) || v.name), isMain(v) ? el('span', { className: 'rt-hist-star', role: 'img', 'aria-label': 'Main' }, icon(ICON.star, true)) : null,
            isHidden(v) ? el('span', { className: 'rt-hist-star', role: 'img', 'aria-label': 'Hidden' }, icon(ICON.eyeClosed)) : null),
          sub ? el('span', { className: 'rt-muted rt-hist-sub' }, sub) : null)))
  }))
}

// Lineage mode: every shown version of the asset as a node on a canvas, parent → child as curves, the path from
// the root to the selected version in the accent colour. Drag (or Space + drag) pans, wheel pans, Ctrl/⌘ + wheel
// or a pinch zooms, + − 0 zoom and fit. Click selects; double-click or Enter opens it in Review.
// Review | Compare | Lineage for the selected version: one radio group at the left of the stage title row.
// Arrows move and pick (roving focus); a disabled choice says why in its name and title.
const MODES = [['review', 'Review'], ['compare', 'Compare'], ['lineage', 'Lineage']]
function ModeSwitch({ mode, onPick, off = {} }) {
  const live = MODES.filter(([k]) => !off[k])
  const keys = e => {
    const d = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key]
    if (!d) return
    e.preventDefault()
    const i = live.findIndex(([k]) => k === mode), next = live[(i + d + live.length) % live.length]
    if (next) onPick(next[0])
  }
  return el('div', { className: 'rt-view rt-modes', role: 'radiogroup', 'aria-label': 'View', onKeyDown: keys },
    ...MODES.map(([k, label]) => el('button', { key: k, type: 'button', role: 'radio', 'aria-checked': mode === k, tabIndex: mode === k ? 0 : -1,
      'aria-disabled': off[k] ? 'true' : undefined, 'aria-label': off[k] ? `${label} · ${off[k]}` : label, title: off[k] || label,
      onClick: () => { if (!off[k] && mode !== k) onPick(k) } }, icon(ICON[k]), el('span', {}, label))))
}
function Lineage({ scope, items, layout, skipped, path, current, ordinalOf, originOf, onSelect, onOpen, lead, tools }) {
  const port = useRef(null)
  const { w: W, h: H } = layout
  const [view, setView] = useState({ x: 0, y: 0, z: 1 })
  const viewRef = useRef(view); viewRef.current = view
  const auto = useRef(true) // still fitted: follows resizes until the user pans or zooms
  const [grab, setGrab] = useState(false), [panning, setPanning] = useState(false)
  const ptrs = useRef(new Map()), drag = useRef(null), pinch = useRef(null), moved = useRef(false)
  const clampZ = z => Math.max(LIN_ZMIN, Math.min(LIN_ZMAX, Number.isFinite(z) ? z : 1))
  // Some of the canvas always stays in the viewport.
  const clampPan = v => {
    const p = port.current
    if (!p) return v
    const keep = 48, vw = p.clientWidth, vh = p.clientHeight
    return { z: v.z, x: Math.max(keep - W * v.z, Math.min(vw - keep, v.x)), y: Math.max(keep - H * v.z, Math.min(vh - keep, v.y)) }
  }
  const fitView = () => {
    const p = port.current
    if (!p || !p.clientWidth || !p.clientHeight || !W || !H) return { x: LIN_PAD, y: LIN_PAD, z: 1 }
    const z = clampZ(Math.min(1, (p.clientWidth - 2 * LIN_PAD) / W, (p.clientHeight - 2 * LIN_PAD) / H))
    return { z, x: (p.clientWidth - W * z) / 2, y: (p.clientHeight - H * z) / 2 }
  }
  const fit = () => { auto.current = true; setView(fitView()) }
  const zoomAt = (z, at) => {
    auto.current = false
    setView(v => { const p = port.current, c = at || { x: (p?.clientWidth || 0) / 2, y: (p?.clientHeight || 0) / 2 }, nz = clampZ(z), k = nz / v.z
      return clampPan({ z: nz, x: c.x - (c.x - v.x) * k, y: c.y - (c.y - v.y) * k }) })
  }
  const zoomStep = dir => zoomAt(viewRef.current.z * (dir > 0 ? 1.25 : 0.8))
  const local = e => { const r = port.current.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
  useLayoutEffect(() => { if (auto.current) fit(); else setView(clampPan) }, [W, H])
  useEffect(() => {
    const node = port.current
    if (!node) return
    const wheel = e => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) { zoomAt(viewRef.current.z * Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * .01), local(e)); return }
      auto.current = false; setView(v => clampPan({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
    }
    node.addEventListener('wheel', wheel, { passive: false })
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => setView(v => auto.current ? fitView() : clampPan(v))) : null
    resized?.observe(node)
    return () => { node.removeEventListener('wheel', wheel); resized?.disconnect() }
  }, [W, H])
  // Keys act only with focus inside Retake, never while typing, in a menu or dialog, or on auto-repeat.
  useEffect(() => {
    const free = e => {
      const root = port.current?.closest('.retake')
      if (!root || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || typingIn(e.target)) return false
      if (!(e.target === document.body || root.contains(e.target))) return false
      return !e.target?.closest?.('[role=menu],[role=slider],video,audio') && !root.querySelector('[role=menu],.rt-overlay')
    }
    const release = () => setGrab(false)
    const down = e => {
      if (!free(e)) return
      // Space is the pan modifier on the canvas (a focused node is never picked by it); other controls keep it.
      if (e.key === ' ') { if (port.current?.contains(e.target) || !e.target?.closest?.('button,a[href],input,label,select,summary')) e.preventDefault(); if (!e.repeat) setGrab(true); return }
      if (e.repeat) return
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomStep(1) }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomStep(-1) }
      else if (e.key === '0') { e.preventDefault(); fit() }
    }
    const up = e => { if (e.key !== ' ') return; release(); if (port.current?.contains(e.target)) e.preventDefault() }
    document.addEventListener('keydown', down); document.addEventListener('keyup', up); window.addEventListener('blur', release)
    return () => { document.removeEventListener('keydown', down); document.removeEventListener('keyup', up); window.removeEventListener('blur', release) }
  }, [W, H])
  // The selected version stays in view (e.g. after ←/→).
  useEffect(() => {
    const p = port.current, n = p?.querySelector('.rt-lin-node[data-active=true]')
    if (!p || !n) return
    const pr = p.getBoundingClientRect(), nr = n.getBoundingClientRect(), m = 12
    const dx = nr.left < pr.left + m ? pr.left + m - nr.left : nr.right > pr.right - m ? pr.right - m - nr.right : 0
    const dy = nr.top < pr.top + m ? pr.top + m - nr.top : nr.bottom > pr.bottom - m ? pr.bottom - m - nr.bottom : 0
    if (dx || dy) setView(v => clampPan({ ...v, x: v.x + dx, y: v.y + dy }))
  }, [current])
  // Opening Lineage puts focus on the selected version, so arrows and Enter work at once.
  useEffect(() => { port.current?.querySelector('.rt-lin-node[data-active=true] button')?.focus({ preventScroll: true }) }, [])
  const pointerDown = e => {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    moved.current = false
    if (ptrs.current.size === 2) {
      const [a, b] = [...ptrs.current.values()]
      drag.current = null
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: viewRef.current.z }
      return
    }
    // A drag that starts on a node pans once it moves; with Space held or the middle button it pans at once.
    const now = grab || e.button === 1
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: viewRef.current.x, y: viewRef.current.y, on: false }
    if (now) { e.preventDefault(); start(e) }
  }
  const start = e => { drag.current.on = true; auto.current = false; port.current?.setPointerCapture?.(e.pointerId); setPanning(true) }
  const pointerMove = e => {
    if (!ptrs.current.has(e.pointerId)) return
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch.current && ptrs.current.size >= 2) {
      const [a, b] = [...ptrs.current.values()], r = port.current.getBoundingClientRect()
      moved.current = true
      zoomAt(pinch.current.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.d), { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top })
      return
    }
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    if (!d.on && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) start(e)
    if (d.on) setView(v => clampPan({ ...v, x: d.x + e.clientX - d.sx, y: d.y + e.clientY - d.sy }))
  }
  const pointerEnd = e => {
    ptrs.current.delete(e.pointerId)
    if (ptrs.current.size < 2) pinch.current = null
    if (drag.current?.id === e.pointerId) { if (drag.current.on) moved.current = true; drag.current = null; setPanning(false) }
  }
  const node = v => {
    const at = layout.pos.get(v.id), active = v.id === current, o = originOf(v)
    const src = o.tags.find(t => t.kind !== 'parent'), ord = ordinalOf(v) || v.name
    return el('li', { key: v.id, className: 'rt-lin-node', 'data-active': active ? 'true' : undefined, 'data-path': path.has(v.id) ? 'true' : undefined, 'data-mark': isMain(v) ? 'main' : isHidden(v) ? 'hidden' : undefined,
      'data-row': at.row, 'data-col': at.col, style: { left: at.col * (LIN_W + LIN_GX), top: at.row * (LIN_H + LIN_GY), width: LIN_W, height: LIN_H } },
      el('button', { type: 'button', className: 'rt-lin-btn', 'aria-pressed': active, 'aria-label': `${ord} ${v.name}${isMain(v) ? ', Main' : ''}${isHidden(v) ? ', Hidden' : ''}`, title: [v.name, o.title, markText(v)].filter(Boolean).join(' · '),
        onClick: () => onSelect(v.id), onDoubleClick: () => onOpen(v.id), onKeyDown: e => { if (e.key === 'Enter' && !e.repeat && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); onOpen(v.id) } } },
        h(Thumb, { scope, version: v }),
        el('span', { className: 'rt-lin-label' }, el('b', {}, ord),
          isMain(v) ? el('span', { className: 'rt-lin-star', role: 'img', 'aria-label': 'Main' }, icon(ICON.star, true)) : null,
          isHidden(v) ? el('span', { className: 'rt-lin-eye', role: 'img', 'aria-label': 'Hidden' }, icon(ICON.eyeClosed)) : null,
          src ? el('span', { className: 'rt-lin-model' }, src.kind === 'upload' ? 'Upload' : src.text) : null)))
  }
  const edge = ([a, b]) => {
    const p = layout.pos.get(a), c = layout.pos.get(b)
    const x1 = p.col * (LIN_W + LIN_GX) + LIN_W, y1 = p.row * (LIN_H + LIN_GY) + LIN_H / 2, x2 = c.col * (LIN_W + LIN_GX), y2 = c.row * (LIN_H + LIN_GY) + LIN_H / 2, mx = (x1 + x2) / 2
    return h('path', { key: `${a}>${b}`, className: 'rt-lin-edge', d: `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`, 'data-parent': a, 'data-child': b,
      'data-lit': path.has(a) && path.has(b) ? 'true' : undefined, 'data-skip': skipped.has(b) ? 'true' : undefined })
  }
  const lit = layout.edges.filter(([a, b]) => path.has(a) && path.has(b)), dim = layout.edges.filter(x => !lit.includes(x))
  return el('section', { key: 'lineage', className: 'rt-main', 'aria-label': 'Lineage' },
    el('header', { className: 'rt-bar' },
      el('div', { className: 'rt-bar-title' }, lead, el('h3', { className: 'rt-sr' }, 'Lineage')),
      el('div', { className: 'rt-cmp-tools' }, tools,
        el('div', { className: 'rt-view rt-lin-zoom', role: 'group', 'aria-label': 'Zoom' },
          el('button', { type: 'button', 'aria-label': 'Zoom out', disabled: view.z <= LIN_ZMIN + 1e-3, onClick: () => zoomStep(-1) }, icon(ICON.minus)),
          el('button', { type: 'button', 'aria-label': 'Fit', title: `Fit (0) · ${Math.round(view.z * 100)}%`, onClick: fit }, 'Fit'),
          el('button', { type: 'button', 'aria-label': 'Zoom in', disabled: view.z >= LIN_ZMAX - 1e-3, onClick: () => zoomStep(1) }, icon(ICON.plus))))),
    el('div', { ref: port, className: 'rt-lin', role: 'group', 'aria-label': 'Version lineage', 'data-grab': panning ? 'grabbing' : grab ? 'true' : undefined, 'data-zoom': view.z.toFixed(3),
      onPointerDown: pointerDown, onPointerMove: pointerMove, onPointerUp: pointerEnd, onPointerCancel: pointerEnd,
      // A drag that ended on a node is a pan, not a pick.
      onClickCapture: e => { if (moved.current) { moved.current = false; e.preventDefault(); e.stopPropagation() } },
      onDoubleClickCapture: e => { if (moved.current) { e.preventDefault(); e.stopPropagation() } } },
      el('div', { className: 'rt-lin-canvas', style: { width: W, height: H, transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` } },
        // Lit edges last, so the path is drawn over the muted branches.
        h('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true', focusable: 'false' }, ...dim.map(edge), ...lit.map(edge)),
        el('ul', { className: 'rt-lin-nodes', 'aria-label': 'Versions' }, ...items.map(node)))))
}

// Compare two images in ONE box. The box takes the first image's shape; the second is fitted (contain) and
// centred in it, so a different aspect ratio never stretches either. Swipe: the second shows right of a
// draggable handle (a slider). Overlay: the second lies on top at the chosen opacity.
function CompareStack({ scope, a, b, mode, labels }) {
  const qa = useMedia(scope, a), qb = useMedia(scope, b)
  const [pos, setPos] = useState(50), [alpha, setAlpha] = useState(50)
  const [ar, setAr] = useState(a.width > 0 && a.height > 0 ? a.width / a.height : 16 / 10)
  const stack = useRef(null)
  const wait = mediaState(qa) || mediaState(qb)
  if (wait) return el('div', { className: 'rt-cmp-one' }, el('div', { className: 'rt-cmp-box' }, wait))
  const clamp = v => Math.max(0, Math.min(100, v))
  const fromPointer = e => { const r = stack.current?.getBoundingClientRect(); if (r?.width) setPos(clamp((e.clientX - r.left) / r.width * 100)) }
  const swipe = mode === 'swipe'
  const keys = e => {
    const step = { ArrowLeft: -2, ArrowDown: -2, ArrowRight: 2, ArrowUp: 2, PageDown: -10, PageUp: 10 }[e.key]
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? 100 : step != null ? clamp(pos + step) : null
    if (to == null) return
    e.preventDefault(); setPos(to)
  }
  const small = v => v.width > 0 && v.height > 0 && Math.max(v.width, v.height) <= 64 ? 'true' : undefined
  return el('div', { className: 'rt-cmp-one', 'data-mode': mode },
    el('div', { className: 'rt-cmp-box' },
      el('div', { ref: stack, className: 'rt-stack', style: { '--rt-ar': ar },
        onPointerDown: swipe ? e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); fromPointer(e); e.currentTarget.querySelector('[role=slider]')?.focus() } : undefined,
        onPointerMove: swipe ? e => { if (e.currentTarget.hasPointerCapture?.(e.pointerId)) fromPointer(e) } : undefined },
        h('img', { src: mediaSrc(qa.data), alt: a.name, draggable: false, 'data-pixels': small(a),
          onLoad: e => { const { naturalWidth: w, naturalHeight: ht } = e.currentTarget; if (w > 0 && ht > 0) setAr(w / ht) } }),
        h('img', { src: mediaSrc(qb.data), alt: b.name, draggable: false, 'data-pixels': small(b), className: 'rt-stack-b',
          style: swipe ? { clipPath: `inset(0 0 0 ${pos}%)` } : { opacity: alpha / 100 } }),
        el('span', { className: 'rt-stack-lab', 'data-side': 'a', 'aria-hidden': 'true' }, labels[0]),
        el('span', { className: 'rt-stack-lab', 'data-side': 'b', 'aria-hidden': 'true' }, labels[1]),
        swipe ? el('div', { className: 'rt-swipe', role: 'slider', tabIndex: 0, 'aria-label': `Swipe ${labels[0]} | ${labels[1]}`, 'aria-orientation': 'horizontal',
          'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pos), 'aria-valuetext': `${labels[1]} from ${Math.round(pos)}%`, style: { left: `${pos}%` }, onKeyDown: keys },
          el('b', { 'aria-hidden': 'true' }, '⇔')) : null)),
    swipe ? null : el('div', { className: 'rt-fade' },
      el('span', { 'aria-hidden': 'true' }, labels[0]),
      el('input', { type: 'range', min: 0, max: 100, value: alpha, 'aria-label': `${labels[0]} … ${labels[1]}`, 'aria-valuetext': `${labels[1]} at ${alpha}%`, onChange: e => setAlpha(Number(e.target.value)) }),
      el('span', { 'aria-hidden': 'true' }, labels[1])))
}

// Full view: view only (no labels, notes or approval). ←/→ move through the asset's versions, Esc or a backdrop click closes.
function Lightbox({ scope, items, version, ordinalOf, onStep, onClose }) {
  const box = useRef(null)
  const media = useMedia(scope, version)
  const i = items.indexOf(version)
  // Opens on Close; keeps focus inside when a step disables the focused arrow.
  useEffect(() => { if (!box.current?.contains(document.activeElement) || document.activeElement?.disabled) box.current?.querySelector('.rt-lb-close')?.focus() }, [version.id])
  const keys = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return }
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key]
    if (step && !e.altKey && !e.ctrlKey && !e.metaKey && !e.target?.closest?.('video')) { e.preventDefault(); if (!e.repeat) onStep(step); return }
    if (e.key !== 'Tab') return
    // Focus stays inside the dialog.
    const f = [...box.current.querySelectorAll('button:not(:disabled),video[controls]')]
    const at = f.indexOf(document.activeElement)
    if (e.shiftKey ? at <= 0 : at === f.length - 1) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0]?.focus() }
  }
  // A click on the backdrop (the dark area, including an image's letterbox) closes; one on the picture, a control or the video does not.
  const backdrop = e => {
    const t = e.target
    if (t === box.current || t.matches?.('.rt-lb-body,.rt-lb-media,.rt-lb-dots,.rt-lb-top')) return true
    if (t.tagName !== 'IMG' || !t.naturalWidth || !t.naturalHeight) return false
    const r = t.getBoundingClientRect(), k = Math.min(r.width / t.naturalWidth, r.height / t.naturalHeight)
    const w = t.naturalWidth * k, ht = t.naturalHeight * k, x = e.clientX - r.left - (r.width - w) / 2, y = e.clientY - r.top - (r.height - ht) / 2
    return x < 0 || y < 0 || x > w || y > ht
  }
  const downOnBackdrop = useRef(false) // a drag that starts on the picture and ends on the backdrop does not close
  const p = media.data
  const content = mediaState(media) || (p.mime.startsWith('image/')
    ? h('img', { key: version.id, src: mediaSrc(p), alt: version.name, draggable: false, 'data-pixels': version.width && version.height && Math.max(version.width, version.height) <= 64 ? 'true' : undefined })
    : h('video', { key: version.id, src: mediaSrc(p), controls: true, preload: 'metadata', 'aria-label': version.name }))
  const ord = ordinalOf(version)
  return el('div', { className: 'rt-overlay rt-lb', role: 'dialog', 'aria-modal': 'true', tabIndex: -1, 'aria-label': `${[ord, version.name].filter(Boolean).join(' · ')} · full view`, ref: box, onKeyDown: keys,
    onPointerDown: e => { downOnBackdrop.current = e.button === 0 && backdrop(e) },
    onClick: e => { if (downOnBackdrop.current && backdrop(e)) onClose(); downOnBackdrop.current = false } },
    el('div', { className: 'rt-lb-top' }, el('strong', {}, ord), mark(version),
      el('button', { type: 'button', className: 'rt-lb-close', 'aria-label': 'Close full view', onClick: onClose }, icon(ICON.x))),
    el('div', { className: 'rt-lb-body' },
      el('button', { type: 'button', className: 'rt-lb-nav', 'aria-label': 'Previous version', disabled: i <= 0, onClick: () => onStep(-1) }, icon(ICON.left)),
      el('div', { className: 'rt-lb-media' }, content),
      el('button', { type: 'button', className: 'rt-lb-nav', 'aria-label': 'Next version', disabled: i < 0 || i >= items.length - 1, onClick: () => onStep(1) }, icon(ICON.right))),
    items.length > 1 ? el('div', { className: 'rt-lb-dots', 'aria-hidden': 'true' }, ...items.map((x, n) => el('i', { key: x.id, 'data-on': n === i ? 'true' : undefined }))) : null)
}

function Cover({ scope, project }) {
  const v = project.cover_version
  const usable = v && typeof v.id === 'string' && v.project_id === project.id && /^image\/(png|jpeg|webp)$/.test(v.mime)
  if (!usable) return el('span', { className: 'rt-cover', 'data-kind': 'initials', 'aria-hidden': 'true' }, initials(project.name))
  return h(Thumb, { scope, version: v, className: 'rt-cover', fallback: initials(project.name) })
}

// Stage + inspector for exactly one version. Keyed by version id; unfinished input is cached per version.
function Review({ scope, version, versions, assetLabel, ordinalOf = () => '', originOf = () => ({ tags: [] }), detail, act, busy, drafts, tab, setTab, fieldsOpen, setFieldsOpen, gen, route, generating, blocked, onGenerate, picks, recent, lastModel, pickModel, attempts, onOpen, onCompare, onCheck, onSend, onCancel, onExpand, pendingGen, onHideGen, onRemoveNote, modeSwitch }) {
  const stageTool = useTool()
  const kept = drafts.current.get(version.id) || {}
  const [note, setNote] = useState(kept.note || '')
  // Draw-first: no box until the user drags one (or an unfinished one is restored for this version).
  const [region, setRegion] = useState(kept.region || null)
  const [timestamp, setTimestamp] = useState(kept.timestamp ?? 0)
  const [change, setChange] = useState(kept.change || '')
  const [preserve, setPreserve] = useState(kept.preserve || '')
  const [inspected, setInspected] = useState(null)
  const [briefId, setBriefId] = useState('')
  const [reviseFor, setReviseFor] = useState(null) // { id, model } of the saved request awaiting the confirm step; the model is frozen when it opens
  const [aspect, setAspect] = useState(kept.aspect || aspectOf(version))
  const [model, setModel] = useState(kept.model ?? null) // null = not chosen here: opens on the asset's last model, else the last one picked
  const preferred = assetModelOf(attempts, versions, version.asset_id) ?? lastModel
  const modelId = chosenOf(picks, true, model ?? preferred) ? (model ?? preferred) : '' // a remembered model that cannot revise (Ideogram V3) falls back to the Hermes default
  const [moreMenu, setMoreMenu] = useState(false)
  useEffect(() => { drafts.current.set(version.id, { note, change, preserve, region, timestamp, aspect, model }) }, [note, change, preserve, region, timestamp, aspect, model])
  const forget = keys => { const d = drafts.current.get(version.id); if (d) for (const k of keys) d[k] = '' }
  const shownRegion = inspected?.region || region
  const newRegion = value => { setInspected(null); setRegion(value) }
  const compose = useRef(null)
  const [drawn, setDrawn] = useState(0) // bumps on each finished drag, to focus the note box once it renders
  useEffect(() => { if (drawn) compose.current?.querySelector('textarea')?.focus() }, [drawn])
  const discard = () => { setInspected(null); setRegion(null); setNote(''); forget(['note']) }
  // Escape from anywhere outside a text field closes this version's ⋯ menu, else the pending new-mark form.
  // Handlers that already used the key (fields, menus, dialogs) mark it with preventDefault.
  const pendingMark = version.mime !== 'video/mp4' && !!region && !inspected
  useEffect(() => {
    if (!moreMenu && !pendingMark) return
    const onKey = e => {
      if (e.key !== 'Escape' || e.defaultPrevented || typingIn(e.target)) return
      if (!moreMenu && document.querySelector('.retake [role=menu], .retake .rt-overlay')) return // the open menu or dialog goes first
      e.preventDefault()
      if (moreMenu) setMoreMenu(false); else discard()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [moreMenu, pendingMark])
  const parentVersion = version.parent_id ? versions.find(x => x.id === version.parent_id) : null
  const video = version.mime === 'video/mp4'
  const base = `/projects/${enc(version.project_id)}/versions/${enc(version.id)}`
  const setMark = to => act(markJob(version, to, ordinalOf, versions))
  const annotations = detail.annotations.filter(a => a.version_id === version.id)
  const briefs = detail.briefs.filter(b => b.version_id === version.id)
  const brief = useQuery({ queryKey: [...scope.key, 'brief', version.project_id, briefId], queryFn: () => scope.read(`/projects/${enc(version.project_id)}/briefs/${enc(briefId)}`), enabled: !!briefId, retry: false })
  const validRegion = !!region && Object.values(region).every(Number.isFinite) && region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0 && region.x + region.width <= 1.000001 && region.y + region.height <= 1.000001
  const validTime = Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= Math.min(120, version.duration ?? 120)
  const canAdd = !busy && !inspected && !!note.trim() && (video ? validTime : validRegion)
  const addNote = () => act({ path: `${base}/annotations`, body: video ? { kind: 'timestamp', note: note.trim(), timestamp } : { kind: 'region', note: note.trim(), region },
    after: () => { forget(['note']); setNote(''); if (!video) setRegion(null) } })
  // The note leaves the list at once; the page deletes it when the "Note N removed" toast closes, unless Undo is pressed.
  const removeNote = (a, n) => { if (inspected?.id === a.id) setInspected(null); onRemoveNote(a, n, `${base}/annotations/${enc(a.id)}`) }
  // One saved note's text at a time is edited in place: Enter or blur saves, Esc cancels, empty keeps the old text.
  // Region, kind, id, number and order never change. The ref makes each edit finish once (Esc then blur, Enter then blur).
  const [edit, setEdit] = useState(null) // { id, text }
  const editRef = useRef(null)
  const startEdit = a => { editRef.current = { id: a.id, text: a.note, was: a.note }; setEdit(editRef.current) }
  const saveEdit = (id, note, n, keepToasts) => act({ path: `${base}/annotations/${enc(id)}`, method: 'PATCH', body: { note }, keepToasts, done: () => ({ kind: 'ok', quiet: true, text: `Note ${n} saved.` }) })
  // This view is keyed by version: when the version changes under an open edit (e.g. a revision of it lands and opens),
  // the edit is saved as if the field had lost focus.
  const unmountEdit = useRef(null)
  unmountEdit.current = () => {
    const e = editRef.current
    if (!e) return
    editRef.current = null
    const next = e.text.trim(), n = annotations.findIndex(x => x.id === e.id) + 1
    if (next && next !== e.was && n > 0) saveEdit(e.id, next, n, true)
  }
  useEffect(() => () => unmountEdit.current?.(), [])
  const typeEdit = value => { editRef.current = { ...editRef.current, text: value }; setEdit(editRef.current) }
  const notesList = useRef(null)
  // Enter and Esc hand focus back to the note's Edit button; a blur leaves focus where the user put it.
  const finishEdit = (save, a, n, refocus) => {
    const e = editRef.current
    if (!e || e.id !== a.id) return
    editRef.current = null; setEdit(null)
    if (refocus) requestAnimationFrame(() => notesList.current?.querySelector(`[aria-label="Edit note ${n}"]`)?.focus())
    const next = e.text.trim()
    if (save && next && next !== a.note) saveEdit(a.id, next, n)
  }
  // Main and Hidden pressed while a note is open: mousedown keeps focus in the note (so the blur-save can't disable the
  // button under the click), then the click saves the note and applies the mark in turn.
  const keepEdit = e => { if (editRef.current) e.preventDefault() }
  const markAfterEdit = async to => {
    const e = editRef.current
    if (e) {
      editRef.current = null; setEdit(null)
      const next = e.text.trim(), n = annotations.findIndex(x => x.id === e.id) + 1
      if (next && next !== e.was && n > 0) await saveEdit(e.id, next, n)
    }
    setMark(to)
  }
  // Delete or Backspace removes the note whose region is selected on the image; Enter or F2 edits it (never while typing).
  useEffect(() => {
    if (!inspected) return
    const onKey = e => {
      const del = e.key === 'Delete' || e.key === 'Backspace', change = e.key === 'F2' || (e.key === 'Enter' && stageKeysFree(e))
      if ((!del && !change) || e.defaultPrevented || typingIn(e.target)) return
      const i = annotations.findIndex(a => a.id === inspected.id)
      if (i < 0) return
      e.preventDefault()
      if (del) removeNote(annotations[i], i + 1); else if (!busy) startEdit(annotations[i])
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })
  const copy = async () => { try { scope.assert(); await navigator.clipboard.writeText(JSON.stringify(brief.data, null, 2)); scope.assert() } catch (e) { if (scope.current()) host.notify({ kind: 'error', message: text(e) }) } }

  const stage = el('section', { key: 'stage', className: 'rt-main', 'aria-label': 'Version review', 'aria-busy': busy },
    el('header', { className: 'rt-bar rt-bar-review' },
      el('div', { className: 'rt-bar-title' },
        modeSwitch,
        ordinalOf(version) ? el('span', { className: 'rt-bar-v', title: [!version.parent_id ? 'Original' : parentVersion ? `Revision of ${ordinalOf(parentVersion) || parentVersion.name}` : 'Revision', facts(version)].filter(Boolean).join(' · ') }, ordinalOf(version)) : null,
        el('h3', { className: 'rt-trunc', title: assetLabel }, assetLabel),
        // Main toggle, a Hidden chip that unhides, and ⋯ with both actions (keys S and X do the same).
        el('span', { className: 'rt-menu-wrap rt-marks', role: 'group', 'aria-label': 'Main and hide', onKeyDown: e => { if (e.key === 'Escape' && moreMenu) { e.preventDefault(); setMoreMenu(false) } },
          onBlur: e => { if (!e.currentTarget.contains(e.relatedTarget)) setMoreMenu(false) } },
          el('button', { type: 'button', className: 'rt-main-btn', disabled: busy, 'aria-pressed': isMain(version), title: isMain(version) ? 'Main · S unsets' : 'Set as main · S', onMouseDown: keepEdit, onClick: () => markAfterEdit(toggleMain(version)) },
            icon(ICON.star, isMain(version)), 'Main'),
          isHidden(version) ? el('button', { type: 'button', className: 'rt-hidden-chip', disabled: busy, 'aria-label': 'Hidden. Unhide', title: 'Unhide · X', onMouseDown: keepEdit, onClick: () => markAfterEdit('none') }, icon(ICON.eyeClosed), 'Hidden') : null,
          el('button', { type: 'button', className: 'rt-more', disabled: busy, 'aria-haspopup': 'menu', 'aria-expanded': moreMenu, 'aria-label': 'Version actions', title: 'Version actions', onClick: () => setMoreMenu(!moreMenu) }, icon(ICON.more, true)),
          moreMenu ? el('div', { className: 'rt-menu rt-marks-menu', role: 'menu', 'aria-label': 'Version actions' },
            el('button', { type: 'button', role: 'menuitem', autoFocus: true, onClick: () => { setMoreMenu(false); setMark(toggleMain(version)) } }, icon(ICON.star, isMain(version)), isMain(version) ? 'Unset main' : 'Set as main', el('span', { className: 'rt-kbd', 'aria-hidden': 'true' }, 'S')),
            el('button', { type: 'button', role: 'menuitem', onClick: () => { setMoreMenu(false); setMark(toggleHidden(version)) } }, icon(ICON.eyeClosed), isHidden(version) ? 'Unhide' : 'Hide version', el('span', { className: 'rt-kbd', 'aria-hidden': 'true' }, 'X'))) : null),
        version.width && version.height ? el('span', { className: 'rt-bar-dim', title: 'Stored pixel dimensions' }, `${version.width}×${version.height}`) : null,
        h(Download, { scope, version }))),
    h(Trail, { scope, chain: trailOf(version, versions), ordinalOf, onOpen, busy }),
    el('div', { className: 'rt-stage', 'data-gen': pendingGen ? 'true' : undefined },
      // Generating from this version: the parent stays visible, dimmed, until the new version arrives.
      pendingGen ? el('div', { key: 'gen', className: 'rt-genov' }, el('div', { className: 'rt-genov-card' },
        el('span', { className: 'rt-spin', 'aria-hidden': 'true' }),
        el('p', { role: 'status' }, `Generating ${pendingGen.to} from ${pendingGen.from}`),
        el('span', { className: 'rt-genbar', 'aria-hidden': 'true' }, el('i')),
        btn(`View ${pendingGen.from}`, onHideGen))) : null,
      h(Media, { key: 'media', scope, version, region: video ? null : shownRegion, saved: !!inspected, draftN: annotations.length + 1, onRegion: b => { setTab('request'); newRegion(b); setDrawn(n => n + 1) }, onTime: setTimestamp, onExpand,
      marks: annotations.map((a, i) => ({ id: a.id, n: i + 1, region: a.region, active: inspected?.id === a.id })).filter(m => m.region && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(m.region[k]))) })))

  // The marks ARE the request: numbered like the media, with the new-mark form inline (images: only after a drag).
  const marksGroup = [
    el('h5', { key: 'mh', className: 'rt-eyebrow' }, `Changes · marked on the ${video ? 'video' : 'image'}`),
    annotations.length === 0 ? null : el('ol', { key: 'list', ref: notesList, className: 'rt-notes', 'aria-label': 'Saved notes' }, ...annotations.map((a, i) => {
      const active = inspected?.id === a.id
      // Same number as the marker drawn on the media; a region note's whole row toggles that region on the media.
      const kindTag = el('span', { key: 'k', className: 'rt-note-kind' }, el('span', { className: 'rt-note-n', 'aria-label': `Note ${i + 1}` }, i + 1), a.kind === 'timestamp' ? ` ${Number(a.timestamp).toFixed(1)}s` : null)
      // The edit saves when focus leaves the field AND its buttons (a click elsewhere, Tab past Save), so Tab or an
      // accessibility press can reach Cancel and Save first.
      if (edit?.id === a.id) return el('li', { key: a.id, 'data-active': active ? 'true' : undefined, 'data-editing': 'true',
        onBlur: e => { if (!e.currentTarget.contains(e.relatedTarget)) finishEdit(true, a, i + 1) } },
        el('div', { className: 'rt-note' }, kindTag, h(Textarea, { className: 'rt-note-edit', 'aria-label': `Edit note ${i + 1}`, value: edit.text, autoFocus: true, maxLength: 4000,
          onFocus: e => { const t = e.currentTarget; t.setSelectionRange(t.value.length, t.value.length) }, onChange: e => typeEdit(e.target.value),
          onKeyDown: e => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finishEdit(false, a, i + 1, true) }
            else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) { e.preventDefault(); finishEdit(true, a, i + 1, true) }
          } })),
        // mousedown keeps focus in the field, so Cancel never triggers the blur-save first.
        el('div', { className: 'rt-note-edit-acts' },
          el('button', { type: 'button', className: 'rt-note-edit-btn', title: 'Cancel · Esc', onMouseDown: e => e.preventDefault(), onClick: () => finishEdit(false, a, i + 1, true) }, 'Cancel'),
          el('button', { type: 'button', className: 'rt-note-edit-btn', 'data-primary': 'true', title: 'Save · Enter', onMouseDown: e => e.preventDefault(), onClick: () => finishEdit(true, a, i + 1, true) }, 'Save')))
      const body = [kindTag, el('span', { key: 't', className: 'rt-note-text' }, a.note)]
      const onDoubleClick = busy ? undefined : () => startEdit(a)
      return el('li', { key: a.id, 'data-active': active ? 'true' : undefined }, a.kind === 'region'
        ? el('button', { type: 'button', className: 'rt-note', onClick: () => setInspected(active ? null : a), onDoubleClick, 'aria-label': `Show region: ${a.note}`, 'aria-pressed': active }, ...body)
        : el('div', { className: 'rt-note', onDoubleClick }, ...body),
        el('button', { type: 'button', className: 'rt-icon rt-note-act', disabled: busy, 'aria-label': `Edit note ${i + 1}`, title: 'Edit note · Enter', onClick: () => startEdit(a) }, icon(ICON.edit)),
        el('button', { type: 'button', className: 'rt-icon rt-note-act rt-note-remove', disabled: busy, 'aria-label': `Remove note ${i + 1}`, title: 'Remove note', onClick: () => removeNote(a, i + 1) }, icon(ICON.x)))
    })),
    // Images: the form exists only while a drawn box is pending (inspecting a saved note hides it). Video: always.
    video || (region && !inspected) ? el('div', { key: 'compose', ref: compose, className: 'rt-newmark', role: 'group', 'aria-label': 'New note',
      onKeyDown: video ? undefined : e => { if (e.key === 'Escape') { e.preventDefault(); discard() } } },
      video ? field('Time (seconds)', timestamp, v => setTimestamp(Number(v)), { type: 'number', min: 0, max: Math.min(120, version.duration ?? 120), step: .1 }) : null,
      el('div', { className: 'rt-newmark-row' },
        el('span', { className: 'rt-note-n', 'aria-label': `Note ${annotations.length + 1}` }, annotations.length + 1),
        el('label', {}, el('span', { className: 'rt-sr' }, 'Note'), h(Textarea, { 'aria-label': 'Note', value: note, placeholder: video ? 'Pause the video, then describe the change' : 'Describe the change', onChange: e => setNote(e.target.value),
          onKeyDown: e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) { e.preventDefault(); if (canAdd) addNote() } } }))),
      el('div', { className: 'rt-compose-foot' },
        video ? null : el('details', { className: 'rt-details', open: fieldsOpen, onToggle: e => setFieldsOpen(e.currentTarget.open) },
          el('summary', {}, 'Exact position'),
          el('div', { className: 'rt-numbers' }, ...['x', 'y', 'width', 'height'].map(k => field(k, region[k], v => newRegion({ ...region, [k]: Number(v) }), { key: k, type: 'number', min: 0, max: 1, step: .01 })))),
        el('div', { className: 'rt-row' },
          video ? null : btn('Cancel', discard, { disabled: busy }),
          btn('Add', addNote, { variant: undefined, disabled: !canAdd, 'aria-label': 'Add note' })))) : null,
    video || stageTool === 'hand' ? null : el('p', { key: 'hint', className: 'rt-muted rt-draw-hint' }, annotations.length ? 'Drag on the image to mark another change.' : 'Drag on the image to mark a change.')
  ]

  const snapshots = brief.data?.annotations?.length ?? 0
  const opened = !briefId ? null : brief.error ? el('p', { role: 'alert', className: 'rt-muted' }, text(brief.error)) : brief.data ? el('article', { className: 'rt-brief', 'aria-label': 'Saved request' },
    el('div', { className: 'rt-row rt-between' }, el('span', {}), btn('Copy JSON', copy, { 'aria-label': 'Copy request JSON' })),
    el('dl', {}, el('div', {}, el('dt', { className: 'rt-eyebrow' }, 'Change'), el('dd', {}, brief.data.change)), el('div', {}, el('dt', { className: 'rt-eyebrow' }, 'Preserve'), el('dd', {}, brief.data.preserve))),
    el('p', { className: 'rt-muted', title: 'A fixed copy, taken at save, of the notes this version had then.' }, `${plural(snapshots, 'note')} · version `, el('span', { className: 'rt-id' }, brief.data.version_id))) : el('p', { role: 'status', className: 'rt-muted' }, 'Loading…')
  // Saving a request snapshots this version's notes with the text. Generate saves first, then opens the confirm step.
  // Empty boxes fall back to these defaults so the stored brief has real text.
  // Only the change is required: a highlighted area or typed text. Keep is always optional.
  const defaults = annotations.length ? { change: 'Apply the numbered notes.', preserve: 'Everything not marked.' } : { change: '', preserve: 'Everything else.' }
  const requestBody = { change: change.trim() || defaults.change, preserve: preserve.trim() || defaults.preserve }
  const requestReady = !!(requestBody.change && requestBody.preserve)
  const saveRequest = generate => act({ path: `${base}/briefs`, body: requestBody, after:b => { forget(['change', 'preserve']); setChange(''); setPreserve(''); setBriefId(''); if (generate) setReviseFor({ id: b.id, model: sel?.id || '' }) } })
  const canGenerate = gen.available && gen.revision && !video
  // Each box has a visible short label; its accessible name stays the question.
  // Optional is marked on the label; placeholders are examples only.
  const box = (label, question, value, onChange, placeholder, optional) => el('label', {}, el('span', {}, label, optional ? el('span', { className: 'rt-opt' }, ' optional') : null), h(Textarea, { 'aria-label': question, value, placeholder, onChange: e => onChange(e.target.value) }))
  const reviseReady = canGenerate && gen.available && route.ready
  const reviseBrief = reviseReady && reviseFor ? briefs.find(x => x.id === reviseFor.id) : null
  const sel = chosenOf(picks, true, modelId) // style-only, text-only and unavailable models are never a revision
  const confirmed = reviseFor ? chosenOf(picks, true, reviseFor.model) : null // what the user saw when the confirm opened
  const request = useRef(null)
  const [backed, setBacked] = useState(0)
  useEffect(() => { if (backed) request.current?.querySelector('.rt-primary')?.focus() }, [backed])
  const nextOrdinal = `v${versions.filter(x => x.asset_id === version.asset_id).length + 1}`
  const fromOrdinal = ordinalOf(version)
  const revisionAttempts = attempts.filter(a => a.parent_id === version.id)
  const requestPanel = [
    el('section', { key: 'next', className: 'rt-next', 'aria-labelledby': 'retake-next-title' },
      el('h3', { className: 'rt-sec-title', id: 'retake-next-title' }, fromOrdinal ? `Next version from ${fromOrdinal}` : 'Next version'),
      ...marksGroup,
      reviseBrief
      ? el('div', { key: 'confirm', className: 'rt-compose' },
        el('p', { className: 'rt-muted rt-quote' }, `“${reviseBrief.change}” · keep “${reviseBrief.preserve}”`),
        h(ReviseConfirm, { scope, gen, version, brief: reviseBrief, title: fromOrdinal ? `Generate ${nextOrdinal} from ${fromOrdinal}` : 'Generate the next version', aspect, model: confirmed,
          onBack: () => { setReviseFor(null); setBacked(n => n + 1) }, generating, blocked, onGenerate }))
      : el('div', { key: 'request', ref: request, className: 'rt-request', role: 'group', 'aria-label': 'Revision request' },
        el('h5', { className: 'rt-eyebrow' }, 'Anything else'),
        box('Change', 'What should change?', change, setChange, annotations.length ? 'Anything not marked on the image' : 'e.g. Make the umbrella red', annotations.length > 0),
        box('Keep', 'What must stay?', preserve, setPreserve, 'e.g. The lighting and framing', true),
        !canGenerate ? el('p', { className: 'rt-muted', role: 'status' }, video ? 'Video versions can’t be generated; save the request and upload the revised file as the next version.' : gen.revisionReason || gen.reason || 'Automatic revision isn’t available here; save the request and upload the revised file as the next version.') : null,
        canGenerate ? h(AspectCards, { value: aspect, onChange: setAspect }) : null,
        canGenerate ? h(ModelChip, { picks, revision: true, value: modelId, recent, onChange: v => { setModel(v); pickModel(v) } }) : null,
        el('div', { className: 'rt-row rt-end' },
          btn('Save for later', () => saveRequest(false), { disabled: busy || !requestReady }),
          canGenerate ? btn('Generate revision…', () => saveRequest(true), { variant: undefined, className: 'rt-primary', disabled: busy || blocked || !requestReady }) : null))),
    pendingAttempts(revisionAttempts).length ? el('section', { key: 'attempts', className: 'rt-gen', 'aria-label': 'Revision attempts' },
      h(AttemptList, { label: 'Revision attempts from this version', attempts: revisionAttempts, onCheck, onSend, onCancel, canSend: reviseReady && !generating })) : null,
    briefs.length ? el('details', { key: 'earlier', className: 'rt-details rt-earlier' },
      el('summary', {}, `Earlier requests (${briefs.length})`),
      el('ul', { className: 'rt-drafts' }, ...briefs.map(b => el('li', { key: b.id },
        el('button', { type: 'button', className: 'rt-draft', 'aria-label': `Open request · ${b.change.slice(0, 55)}`, 'aria-pressed': briefId === b.id, onClick: () => setBriefId(briefId === b.id ? '' : b.id) }, el('span', { className: 'rt-trunc' }, b.change), when(b.created_at) ? el('span', { className: 'rt-muted' }, when(b.created_at)) : null),
        briefId === b.id ? el('div', { className: 'rt-earlier-open' }, opened, canGenerate ? el('div', { className: 'rt-row rt-end' }, btn('Generate revision…', () => setReviseFor({ id: b.id, model: sel?.id || '' }), { variant: undefined, disabled: busy || blocked, 'aria-label': `Generate revision from request · ${b.change.slice(0, 55)}` })) : null) : null)))) : null
  ]

  // The attempt that produced this version, if it was generated: its record lives here, not in the attempt lists.
  const madeBy = attempts.find(a => a.state === 'succeeded' && a.version_id === version.id)
  const reportedBy = madeBy ? reportedOf(madeBy) : ''
  const generation = madeBy ? [['Generated', when(madeBy.created_at)], ['Requested', requestedOf(madeBy) || 'Hermes configured default'],
    ['Reported', reportedBy ? `${reportedBy} · variant not verified` : ''], ['Aspect', madeBy.aspect_ratio], ['Attempt', shortId(madeBy.id)]] : []
  const identity = [['File', version.name], ['Version', version.id],['Parent', version.parent_id ? `${parentVersion ? `${parentVersion.name} · ` : ''}${version.parent_id}` : 'None · first version of this asset'], ['Asset', version.asset_id], ['SHA-256', version.sha256], ['Added', when(version.created_at)], ...generation].filter(([, v]) => v)
  const details = el('details', { className: 'rt-details rt-identity' },
    el('summary', {}, 'Version details'),
    el('dl', {}, ...identity.map(([k, v]) => el('div', { key: k, className: 'rt-identity-row' }, el('dt', {}, k), el('dd', { className: 'rt-id', title: k === 'Attempt' ? madeBy.id : undefined }, v)))),
    madeBy?.selection_mismatch ? el('p', { className: 'rt-why' }, MISMATCH) : null,
    el('p', { className: 'rt-muted' }, 'Uploads never overwrite this version. To revise it, upload a file as its next version.'))

  // No separate head: the "Next version from vN" section heading is the panel's heading.
  // Request stays mounted (hidden) while History shows, so a half-written request and its focus survive the switch.
  const tabs = [['request', 'Request'], ['history', 'History']]
  const history = h(History, { scope, items: versions.filter(x => x.asset_id === version.asset_id), current: version.id, ordinalOf, originOf, onOpen, busy })
  const inspector = el('section', { key: 'insp', className: 'rt-insp', role: 'region', 'aria-label': 'Review inspector' },
    el('div', { className: 'rt-tabs rt-insp-tabs', role: 'tablist', 'aria-label': 'Inspector' }, ...tabs.map(([id, label]) =>
      el('button', { key: id, type: 'button', role: 'tab', id: `retake-tab-${id}`, 'aria-selected': tab === id, 'aria-controls': `retake-panel-${id}`, tabIndex: tab === id ? 0 : -1, onKeyDown: tabKeys, onClick: () => setTab(id) }, label))),
    el('div', { className: 'rt-insp-body', id: 'retake-panel-request', role: 'tabpanel', 'aria-labelledby': 'retake-tab-request', hidden: tab !== 'request' },
      el('fieldset', { disabled: busy, 'aria-label': 'Feedback controls' }, ...requestPanel, details)),
    el('div', { className: 'rt-insp-body', id: 'retake-panel-history', role: 'tabpanel', 'aria-labelledby': 'retake-tab-history', hidden: tab !== 'history' }, history))
  return [stage, inspector]
}

function Workspace({ ctx, profile, epoch, connectionId = null }) {
  const client = useQueryClient()
  // A Hermes "View" action (generation finished while Retake was closed) opens that version.
  const [opening] = useState(() => { const o = openNext && openNext.profile === profile ? openNext : null; openNext = null; return o })
  const [pid, setPidState] = useState(opening?.projectId || '')
  const projectRef = useRef(opening?.projectId || '')
  const setPid = id => { projectRef.current = id; setPidState(id) }
  const [projectName, setProjectName] = useState('')
  const [creating, setCreating] = useState(null) // { top } of the open New project form beside the rail's +
  const cancelNew = () => { setCreating(null); setProjectName(''); setTimeout(() => root.current?.querySelector('.rt-rail-new')?.focus(), 0) }
  const [active, setActive] = useState(opening?.versionId || '')
  const [compare, setCompare] = useState([])
  const [cmpView, setCmpView] = useState('side') // Compare: side | swipe | overlay; kept for this session only
  const [lightbox, setLightbox] = useState(false) // full view of the reviewed version
  const lightboxFrom = useRef(null) // focus returns here on close
  // Newest first. A new message replaces earlier ok ones (progress and confirmations go stale); errors stay
  // until closed. null clears all. `quiet` ones are announced to screen readers only.
  const [toasts, setToasts] = useState([])
  const toastSeq = useRef(0)
  const setMessage = m => { const id = ++toastSeq.current; setToasts(list => m ? [{ ...m, id }, ...list.filter(t => t.kind === 'error' && !t.quiet)].slice(0, 3) : []) }
  const clearOk = () => setToasts(list => list.filter(t => t.kind === 'error' && !t.quiet)) // errors stay until closed
  const closeToast = id => setToasts(list => list.filter(t => t.id !== id))
  // Removed notes wait for their toast: hidden from the lists now, DELETEd when the toast closes (timeout, dismiss, replaced),
  // when the project or asset changes, before anything that reads stored notes, or (best effort) when the window is hidden or reloaded. Undo cancels.
  const [hiddenNotes, setHiddenNotes] = useState([])
  const pendingNotes = useRef(new Map()) // note id -> { path, toast, project, key }
  const commitNote = id => {
    const p = pendingNotes.current.get(id)
    if (!p) return Promise.resolve()
    if (p.sent) return p.sent
    closeToast(p.toast)
    p.sent = (async () => {
      let failed = false
      try { await ctx.rest(p.path, { method: 'DELETE', body: {} }) } catch (e) { failed = true; if (current() && projectRef.current === p.project && !/not found/i.test(text(e))) setMessage({ kind: 'error', text: text(e) }) }
      if (pendingNotes.current.get(id) === p) pendingNotes.current.delete(id)
      if (!mounted.current) return
      // A failed DELETE shows the note again. A deleted one leaves the cached project first and stays hidden,
      // so no refetch (in flight or of a project opened later) can bring it back.
      if (failed) { setHiddenNotes(l => l.filter(x => x !== id)); return }
      client.setQueryData(p.key, d => Array.isArray(d?.annotations) ? { ...d, annotations: d.annotations.filter(x => x.id !== id) } : d)
      if (current()) await client.invalidateQueries({ queryKey: scope.key })
    })()
    return p.sent
  }
  const flushNotes = () => Promise.all([...pendingNotes.current.keys()].map(commitNote))
  const removeNote = (a, n, path) => {
    const toast = ++toastSeq.current
    pendingNotes.current.set(a.id, { path, toast, project: projectRef.current, key: [...scope.key, 'project', projectRef.current] })
    setHiddenNotes(l => [...l, a.id])
    // Removal toasts stack (each keeps its own Undo until it closes); numbers shift after a removal, so each names its text.
    const said = String(a.note || '').trim(), short = said.length > 32 ? `${said.slice(0, 31)}…` : said
    setToasts(list => [{ kind: 'ok', text: short ? `Note ${n} removed · “${short}”` : `Note ${n} removed`, id: toast, undo: a.id }, ...list.filter(t => (t.kind === 'error' && !t.quiet) || t.undo)].slice(0, 3))
  }
  const undoNote = id => { if (pendingNotes.current.get(id)?.sent) return; pendingNotes.current.delete(id); setHiddenNotes(l => l.filter(x => x !== id)) }
  useEffect(() => { for (const [id, p] of pendingNotes.current) if (!p.sent && !toasts.some(t => t.id === p.toast)) commitNote(id) }, [toasts])
  const [saving, setSaving] = useState(false)
  const [mode, setMode] = useState('review')
  // Opening a project always lands on All assets ('overview'); 'versions' is All versions, 'asset' one asset's review.
  const [view, setView] = useState(opening ? 'asset' : 'overview')
  const [query, setQuery] = useState('') // project search; local filter of the panel and All versions
  const [versionsBy, setVersionsBy] = useState('asset') // All versions: 'asset' | 'date'; kept for this session
  const [mainOnly, setMainOnly] = useState(false)
  const [menu, setMenu] = useState(null) // { id, top, left } of the open project's actions menu
  const [renamingProject, setRenamingProject] = useState('') // project id whose name is being edited in the panel
  const newFile = useRef(null)
  const [dropping, setDropping] = useState(false) // a file is dragged over All assets or All versions
  const [renaming, setRenaming] = useState('') // asset id whose name is being edited
  const [deleting, setDeletingState] = useState(null) // { id, name } of the project awaiting explicit confirmation
  const [deleteError, setDeleteError] = useState('')
  const setDeleting = target => { setDeleteError(''); setDeletingState(target) }
  const [tab, setTab] = useState('request') // right panel: 'request' | 'history'
  const [fieldsOpen, setFieldsOpen] = useState(false)
  const [panelPref, setPanelPref] = useState(null) // the project panel's explicit open/closed choice, until the width class changes
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState(0)
  const mounted = useRef(true)
  const lock = useRef(false)
  const root = useRef(null)
  // Toasts sit top-centre in every view, just under the header rows (title row, plus the version trail in Review).
  useLayoutEffect(() => {
    const anchor = root.current?.querySelector('.rt-toasts'), stack = anchor?.firstChild, main = root.current?.querySelector('.rt-work .rt-main')
    if (!stack || !main) return
    const top = anchor.getBoundingClientRect().top
    const heads = [...main.querySelectorAll(':scope > .rt-bar, :scope > .rt-trail')].filter(n => n.offsetParent)
    stack.style.top = `${Math.round(Math.max(top, ...heads.map(n => n.getBoundingClientRect().bottom)) - top) + 8}px`
  })
  const drafts = useRef(new Map())
  const viewed = useRef(new Map())
  // Generation state is scope-local: this component is keyed by source/profile/epoch, so a switch discards it.
  const [composer, setComposer] = useState(false)
  const composerFrom = useRef(null) // focused when the composer opened; focus returns there on close
  // New assets sent from the composer, shown as cards in All assets until their attempt succeeds (then the
  // asset card takes over) or is dismissed: { key, projectId, title, cid, attemptId, error }.
  const [newRuns, setNewRuns] = useState([])
  const addShown = useRef(false) // All assets, All versions or the empty project: where a new asset is added from
  const [genPrompt, setGenPrompt] = useState('')
  const [genAspect, setGenAspect] = useState('landscape')
  const [models, setModels] = useState(() => loadModels(ctx, profile))
  const pickModel = id => setModels(m => { const n = rememberModel(m, id); saveModels(ctx, profile, n); return n })
  const [generating, setGenerating] = useState(null)
  // An attempt whose answer was lost (or that was already running when the page opened). Retake only READS
  // its record until it settles, then reports that same attempt; it never re-sends it.
  const [watch, setWatch] = useState(null)
  const genLock = useRef(false)
  const requestIds = useRef(new Map()) // frozen request fingerprint -> client_request_id until a durable answer arrives
  const activeRef = useRef('')
  const reviewingRef = useRef(false) // one version is on the stage in Review (not Compare, Lineage or a project-wide view)
  const genShownRef = useRef(null) // { id, parentId } of the attempt whose progress the stage last showed
  // In flight when the page closes: followed in the background and announced through Hermes once settled.
  const inflight = useRef(null) // { projectId, attemptId } being run by this page
  const watchRef = useRef(null)
  watchRef.current = watch
  useEffect(() => {
    mounted.current = true; pagesOpen++
    return () => {
      mounted.current = false; pagesOpen--
      const away = [inflight.current, watchRef.current].filter(Boolean)
      if (host.state.profile.get() === profile && gatewayActivationEpoch() === epoch && connectionNow() === connectionId) for (const x of away) followAway(ctx, profile, epoch, x.projectId, x.attemptId)
    }
  }, [])

  // Measure the route container itself (docked panes can be narrow inside a wide window).
  useLayoutEffect(() => {
    const node = root.current
    if (!node) return
    const measure = () => { const w = node.offsetWidth, h = node.offsetHeight; setWidth(old => Math.abs(old - w) < 1 ? old : w); setHeight(old => Math.abs(old - h) < 1 ? old : h) }
    measure()
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  // Wide routes dock the project panel beside the rail; narrow ones fold it into a toggle that floats it over the work area.
  const narrow = width > 0 && width < NARROW_ROOT
  useEffect(() => { setPanelPref(null) }, [narrow])
  const panelOpen = !!pid && (panelPref ? panelPref === 'open' : !narrow)
  const panelFloat = panelOpen && narrow
  const dock = width > 0 && width - RAIL_W - (panelOpen && !panelFloat ? PANEL_W : 0) < BOTTOM_DOCK ? 'bottom' : 'right'

  const current = () => mounted.current && host.state.profile.get() === profile && gatewayActivationEpoch() === epoch && connectionNow() === connectionId
  const scope = { key: [ctx.source, connectionId, profile, epoch], current, assert: () => { if (!current()) throw new Error('Profile or source changed. Reopen Retake before continuing.') } }
  scope.read = async path => { scope.assert(); const data = await ctx.rest(path); scope.assert(); return data }
  const [fastPoll, setFastPoll] = useState(false) // read-only polling while an attempt is active; never dispatches
  const projects = useQuery({ queryKey: [...scope.key, 'projects'], queryFn: () => scope.read('/projects'), retry: false, refetchInterval: 15000 })
  const detail = useQuery({ queryKey: [...scope.key, 'project', pid], queryFn: () => scope.read(`/projects/${enc(pid)}`), enabled: !!pid, retry: false, refetchInterval: fastPoll ? 3000 : 15000 })
  // Connection names for the scope label (labels only; the host never hands plugins tokens).
  const connections = useQuery({ queryKey: ['retake-connections', connectionId], queryFn: async () => typeof host.connections === 'function' ? host.connections() : [], retry: false, staleTime: 300000 })
  const here = scopeLabel(connectionId, profile, connections.data)
  useEffect(() => { if (projects.data) saveLastScope({ connectionId, profile }) }, [!!projects.data])
  // Retake's backend is missing on this connection: offer the last one where it loaded (a visible, user-chosen switch
  // of the window's active agent, the same as picking it in the roster; never automatic).
  const missing = (projects.error && notInstalled(projects.error)) || (detail.error && notInstalled(detail.error))
  const back = missing ? readLastScope() : null
  const canSwitch = back && typeof host.ensureAgent === 'function' && !(back.connectionId === connectionId && back.profile === profile)
  const switchBack = () => { Promise.resolve().then(() => host.ensureAgent(back.connectionId, back.profile)).catch(e => { if (current()) setMessage({ kind: 'error', text: text(e) }) }) }
  const notHere = () => emptyMain('missing', emptyBox({ kind: 'error', role: 'alert', title: `Retake isn't installed on ${here || 'this connection'}`,
    actions: canSwitch ? btn(`Switch to ${scopeLabel(back.connectionId, back.profile, connections.data)}`, switchBack, { variant: undefined }) : null }))
  const mutation = useMutation({ mutationFn: async job => {
    scope.assert()
    let options = { method: job.method || 'POST', body: job.body }
    if (job.file) {
      const f = job.file
      const limit = f.type === 'video/mp4' ? 32 * 1024 * 1024 : 12 * 1024 * 1024
      if (!UPLOAD_MIMES.includes(f.type)) throw new Error(VIDEO_UPLOADS ? 'Use PNG, JPEG, WebP, or MP4.' : 'Use PNG, JPEG or WebP.')
      if (!f.size || f.size > limit) throw new Error(VIDEO_UPLOADS ? 'File is empty or exceeds the size limit (images 12 MB; video 32 MB).' : 'File is empty or exceeds the 12 MB limit.')
      const data = await fileBase64(f)
      scope.assert()
      options = { method: 'POST', body: { filename: f.name, content_type: f.type, data_base64: data }, timeoutMs: UPLOAD_TIMEOUT_MS }
    }
    scope.assert()
    const result = await ctx.rest(job.path, options)
    scope.assert()
    return result
  } })
  // The lock spans the POST, the awaited invalidation and the completion callback.
  const act = async job => {
    if (!current() || lock.current) return
    lock.current = true
    setSaving(true)
    if (!job.keepToasts) clearOk() // keepToasts: a background save that must not replace what the toasts say
    try {
      await flushNotes()
      const result = await mutation.mutateAsync(job)
      scope.assert()
      await client.invalidateQueries({ queryKey: scope.key })
      scope.assert()
      job.after?.(result)
      const done = job.done?.(result)
      if (job.keepToasts) { /* errors only */ } else if (done) setMessage(done); else setMessage({ kind: 'ok', quiet: !job.file, text: job.file ? 'Version uploaded. Original files and review history are retained.' : 'Saved.' })
    } catch (e) { if (current()) setMessage({ kind: 'error', text: text(e) }) } finally { lock.current = false; if (current()) setSaving(false) }
  }

  // Metadata only: the backend route is static and never generates or checks sign-in.
  const capsQuery = useQuery({ queryKey: [...scope.key, 'generation-capabilities'], queryFn: () => scope.read('/generation-capabilities'), retry: false, staleTime: 60000 })
  const gen = capabilities(capsQuery)
  // A failed or "unavailable" answer is read again when the window or this page comes back, so a transient one doesn't stick.
  const capsAgain = useRef(null)
  capsAgain.current = () => { if (current() && !gen.available && !gen.checking) capsQuery.refetch() }
  useEffect(() => {
    const on = () => { if (document.visibilityState !== 'hidden') capsAgain.current?.() }
    window.addEventListener('focus', on); document.addEventListener('visibilitychange', on)
    return () => { window.removeEventListener('focus', on); document.removeEventListener('visibilitychange', on) }
  }, [])
  // Read-only listing from Hermes for this profile; never generates. Unsupported => no picker, flow unchanged.
  const selQuery = useQuery({ queryKey: [...scope.key, 'image-selections'], queryFn: () => scope.read('/image-selections'), enabled: !!pid && gen.available, retry: false, staleTime: 60000 })
  const picks = { supported: selQuery.data?.supported === true && Array.isArray(selQuery.data.selections), list: Array.isArray(selQuery.data?.selections) ? selQuery.data.selections.filter(d => d && typeof d.id === 'string' && typeof d.display === 'string') : [] }
  // The backend that answers this page's REST calls runs the attempt in the profile it authenticated.
  const route = { ready: true, key: `direct:${profile}`, label: `Hermes profile ${profile}` }
  // Captured at confirm, rechecked after reservation; a profile, epoch, source or project change means "reserved, not run".
  const identity = () => ({ key: route.key, connection: connectionNow(), profile: host.state.profile.get(), epoch: gatewayActivationEpoch(), source: ctx.source, project: projectRef.current })
  const sameIdentity = (a, b) => !!a.key && a.key === b.key && a.connection === b.connection && a.profile === b.profile && a.epoch === b.epoch && a.source === b.source && a.project === b.project
  const readAttempt = async (projectId, attemptId) => {
    const r = await scope.read(`/projects/${enc(projectId)}/generations/${enc(attemptId)}`)
    return r && typeof r === 'object' && r.attempt && r.attempt.id === attemptId ? r.attempt : null
  }
  const stillChecking = (id, lost) => setMessage({ kind: 'ok', head: 'Still checking. ', text: `${lost ? `The answer for attempt ${shortId(id)} was lost; Hermes may still be generating it.` : `Retake could not read attempt ${shortId(id)} yet; it may still be generating.`} Retake keeps reading that attempt and will not send it again.` })
  // The page is mounted but not on screen (window hidden, or Retake behind another pane).
  const pageAway = () => (typeof document !== 'undefined' && document.visibilityState === 'hidden') || (!!root.current && root.current.checkVisibility?.() === false)
  const report = (attempt, spec, viewing, lostAnswer, attemptId = '') => {
    if (!attempt) return stillChecking(attemptId, lostAnswer)
    if (!ACTIVE_ATTEMPT(attempt.state)) {
      if (inflight.current?.attemptId === attempt.id) inflight.current = null
      // Still mounted, so View fronts this page and opens the version here.
      if (pageAway()) announceAway(ctx, attempt.project_id || projectRef.current, attempt, current, typeof host?.navigate === 'function' ? () => { host.navigate('/retake'); if (current()) navigateReview(attempt.version_id) } : null)
    }
    if (attempt.state === 'succeeded' && typeof attempt.version_id === 'string') {
      // The composer closed when it sent; a prompt drafted since is kept.
      if (spec?.kind === 'new_asset') setGenPrompt(p => p.trim() === spec.prompt ? '' : p)
      // Also when its progress is the view on the stage (e.g. an attempt found running after a reload).
      // A new asset opens once stored, but only while its project's All assets, All versions (or empty project) is still the view;
      // anyone who moved on meanwhile stays put (the toast has View).
      const shown = genShownRef.current
      if (spec?.kind === 'new_asset') { if (addShown.current && projectRef.current === (attempt.project_id || projectRef.current)) review(attempt.version_id) }
      // A revision opens only while its parent is still reviewed: never out of Compare, Lineage, All assets or All versions.
      else if (reviewingRef.current && (activeRef.current === viewing || (shown?.id === attempt.id && activeRef.current === shown.parentId))) review(attempt.version_id)
      // Worded at render time from the board (the new version's ordinal); the full record is in Version details.
      return setMessage({ kind: attempt.selection_mismatch ? 'error' : 'ok', made: attempt })
    }
    if (ACTIVE_ATTEMPT(attempt.state) && lostAnswer) return stillChecking(attempt.id, true)
    if (attempt.state === 'unknown') return setMessage({ kind: 'error', head: 'Outcome unknown. ', text: `No version was stored for attempt ${shortId(attempt.id)}, and Retake cannot tell whether it reached the provider; it may have been billed. ${attempt.error?.message || ''} Retake will not retry it.` })
    if (ACTIVE_ATTEMPT(attempt.state)) return setMessage({ kind: 'ok', head: 'Still generating. ', text: `Attempt ${shortId(attempt.id)} is ${attempt.state}. Retake keeps checking its record and will not send it again.` })
    return setMessage({ kind: 'error', head: 'No version created. ', text: `Attempt ${shortId(attempt.id)} · ${ATTEMPT[attempt.state] || 'unrecognized response'}. ${attempt.error?.message || ''} Not retried automatically.` })
  }
  // Ask the backend to claim and run ONE reserved attempt, then only READ its record until it settles.
  // A lost answer means "keep reading the record", never "send again"; the backend refuses a second run.
  const sendAttempt = async (projectId, attemptId, before, spec) => {
    if (!sameIdentity(before, identity())) {
      setMessage({ kind: 'error', head: 'Reserved, not run. ', text: `The profile or project changed before Retake ran attempt ${shortId(attemptId)}. Nothing was sent. Use Run on the reserved attempt, or Cancel reservation.` })
      return
    }
    const viewing = activeRef.current
    inflight.current = { projectId, attemptId }
    setFastPoll(true)
    setMessage({ kind: 'ok', head: 'Generating. ', text: `Running attempt ${shortId(attemptId)}. Keep working; do not resubmit.` })
    let lostAnswer = false, refused = '', attempt = null
    try {
      try {
        scope.assert()
        const r = await ctx.rest(`/projects/${enc(projectId)}/generations/${enc(attemptId)}/run`, { method: 'POST', body: {} })
        if (r && r.started === false && typeof r.reason === 'string') refused = r.reason.slice(0, 300)
      } catch { lostAnswer = true; if (current() && projectRef.current === projectId) stillChecking(attemptId, true) }
      // A failed read is not an outcome: keep reading the SAME attempt (slower) until it settles or the deadline.
      let read = null
      const until = Date.now() + RUN_WAIT_MS
      while (current() && projectRef.current === projectId) {
        try { read = await readAttempt(projectId, attemptId) } catch { read = null }
        if (read) attempt = read
        if ((read && !ACTIVE_ATTEMPT(read.state)) || Date.now() > until || refused) break
        await new Promise(resolve => setTimeout(resolve, read ? 1500 : 3000))
      }
      if (!current()) return
      try { await client.invalidateQueries({ queryKey: scope.key }) } catch { /* the board refreshes on its own */ }
      if (projectRef.current !== projectId) return // the durable result stays in its origin project
      if (refused && attempt?.state === 'reserved') return setMessage({ kind: 'error', head: 'Not run. ', text: refused })
      // Still unsettled (or unreadable): hand the same attempt to the board watcher, which reports it once it settles.
      if (!attempt || ACTIVE_ATTEMPT(attempt.state)) setWatch({ projectId, attemptId, spec, viewing })
      report(attempt, spec, viewing, lostAnswer, attemptId)
    } finally {
      // Only an attempt that may still be running is followed (and announced through Hermes) once the page closes.
      const done = attempt && (!ACTIVE_ATTEMPT(attempt.state) || (refused && attempt.state === 'reserved'))
      if (done && inflight.current?.attemptId === attemptId) inflight.current = null
    }
  }
  // The ONLY generation path: an explicit confirmed click. Guarded synchronously against double clicks;
  // the request ID is reused if the reservation answer is lost, so re-confirming replays, never re-reserves.
  // `track` (optional) hears what happened to this request: { cid } as it is sent, { attemptId } once reserved, { error } when no
  // attempt came back, { drop: true } when nothing was sent, then { done: true }.
  const runGeneration = async (spec, track) => {
    if (genLock.current || lock.current || !current() || !pid || !gen.available || !route.ready || (spec.kind === 'revision' && !gen.revision)) return track?.({ drop: true })
    const before = identity()
    if (before.project !== pid) return track?.({ drop: true })
    genLock.current = true
    if (spec.selection) pickModel(spec.selection)
    const projectId = pid
    const fingerprint = JSON.stringify([projectId, spec.kind, spec.prompt || '', spec.parentId || '', spec.briefId || '', spec.aspect, spec.selection || ''])
    let cid = requestIds.current.get(fingerprint)
    if (!cid) { cid = requestId(); requestIds.current.set(fingerprint, cid) }
    track?.({ cid })
    const body = { client_request_id: cid, confirmed: true, aspect_ratio: spec.aspect, ...(spec.kind === 'revision' ? { parent_id: spec.parentId, brief_id: spec.briefId } : { prompt: spec.prompt }), ...(spec.selection ? { image_selection: spec.selection } : {}) }
    setGenerating({ kind: spec.kind, parentId: spec.parentId || null })
    try {
      let attempt = null
      try {
        scope.assert()
        const result = await ctx.rest(`/projects/${enc(projectId)}/generations`, { method: 'POST', body })
        scope.assert()
        requestIds.current.delete(fingerprint) // durable answer: a deliberate later run gets a new ID
        attempt = result && typeof result === 'object' ? result.attempt : null
        if (typeof attempt?.id === 'string') track?.({ attemptId: attempt.id })
      } catch (e) {
        track?.({ error: `Reservation answer not received. ${text(e)}` })
        if (current() && projectRef.current === projectId) setMessage({ kind: 'error', head: 'Reservation answer not received. ', text: `${text(e)} Nothing was sent to Hermes. If the reservation was stored it appears below as Reserved; confirming the same inputs again reuses this request ID and cannot reserve twice.` })
        return
      }
      await client.invalidateQueries({ queryKey: scope.key })
      if (!current() || projectRef.current !== projectId) return
      if (!attempt || typeof attempt.id !== 'string') { track?.({ error: 'Unexpected answer. Nothing was sent.' }); return setMessage({ kind: 'error', head: 'Unexpected answer. ', text: 'Retake did not return an attempt. Nothing was sent.' }) }
      if (attempt.state !== 'reserved') return report(attempt, spec, activeRef.current, false) // replayed: never re-dispatch
      await sendAttempt(projectId, attempt.id, before, spec)
    } finally { genLock.current = false; track?.({ done: true }); if (current()) setGenerating(null) }
  }
  // "Run" on an already reserved attempt (e.g. the profile or project changed before it ran).
  const sendReserved = async attemptId => {
    if (genLock.current || lock.current || !current() || !pid || !route.ready) return
    genLock.current = true
    setGenerating({ kind: 'send', parentId: null })
    try { await sendAttempt(pid, attemptId, identity(), null) } finally { genLock.current = false; if (current()) setGenerating(null) }
  }
  const cancelReserved = async attemptId => {
    if (genLock.current || lock.current || !current() || !pid) return
    const projectId = pid
    try {
      scope.assert()
      const r = await ctx.rest(`/projects/${enc(projectId)}/generations/${enc(attemptId)}/cancel`, { method: 'POST', body: {} })
      scope.assert()
      await client.invalidateQueries({ queryKey: scope.key })
      if (current() && projectRef.current === projectId) report(r?.attempt || null, null, activeRef.current, false)
    } catch (e) { if (current()) setMessage({ kind: 'error', text: text(e) }) }
  }

  // Ignore a detail payload that belongs to a previously opened project.
  const loaded = detail.data?.project?.id === pid ? detail.data : undefined
  const data = loaded && hiddenNotes.length ? { ...loaded, annotations: loaded.annotations.filter(a => !hiddenNotes.includes(a.id)) } : loaded
  const versions = data?.versions || []
  const assets = groupAssets(versions, data?.asset_names && typeof data.asset_names === 'object' ? data.asset_names : {})
  const selected = versions.find(v => v.id === active)
  const asset = assets.find(a => a.id === selected?.asset_id) || assets[0]
  const assetOf = v => assets.find(a => a.id === v.asset_id)
  // Hidden versions fold into one "N hidden" tile (Lineage: are left out) unless shown or being viewed.
  const [showHidden, setShowHidden] = useState(false)
  useEffect(() => { setShowHidden(false) }, [asset?.id])
  const hiddenCount = asset ? asset.items.filter(isHidden).length : 0
  const stripItems = asset ? asset.items.filter(v => !isHidden(v) || showHidden || v.id === active) : []
  const showOverview = !!data && versions.length > 0 && mode === 'review' && view === 'overview'
  const showVersions = !!data && versions.length > 0 && mode === 'review' && view === 'versions'
  const offAsset = showOverview || showVersions // a project-wide view: no filmstrip, inspector or version keys
  useEffect(() => { const hide = () => { flushNotes() }; window.addEventListener('pagehide', hide); return () => window.removeEventListener('pagehide', hide) }, [])
  useEffect(() => () => { flushNotes() }, [pid, selected?.id, offAsset]) // leaving the project, version or review (or closing the page) deletes pending removals
  // Search narrows the panel's asset list and All versions; it never touches the stored data.
  const hits = data ? searchProject(query, assets, data.annotations, data.briefs) : null
  const foundAssets = hits ? assets.filter(a => a.items.some(v => hits.has(v.id))) : assets
  const busy = mutation.isPending || saving
  activeRef.current = active
  reviewingRef.current = mode === 'review' && !offAsset
  const attempts = Array.isArray(data?.attempts) ? data.attempts.filter(a => a && typeof a.id === 'string' && typeof a.state === 'string') : []
  const runningAttempts = attempts.filter(a => ACTIVE_ATTEMPT(a.state))
  const genBlocked = !!generating || !!watch || runningAttempts.length > 0
  // Reserved, running or unknown: a late result could still land, so the project cannot be deleted yet.
  const openAttempts = attempts.filter(a => ['reserved', 'running', 'unknown'].includes(a.state)).length
  const anyRunning = runningAttempts.some(a => a.state === 'running')
  useEffect(() => { setFastPoll(anyRunning || !!generating || !!watch) }, [anyRunning, generating, watch])
  // Follows the watched attempt on every board read; also adopts an attempt already running when the page
  // opens (e.g. after a reload), so its stored result is announced instead of looking lost.
  useEffect(() => {
    if (!data || generating) return
    if (watch) {
      const a = watch.projectId === data.project.id ? attempts.find(x => x.id === watch.attemptId) : null
      if (a && !ACTIVE_ATTEMPT(a.state)) { setWatch(null); report(a, watch.spec, watch.viewing, false) }
      return
    }
    const running = runningAttempts.find(a => a.state === 'running')
    if (running) setWatch({ projectId: data.project.id, attemptId: running.id, spec: null, viewing: activeRef.current })
  }, [data, watch, generating])
  // A sent new asset whose attempt succeeded is its asset card now.
  useEffect(() => {
    const done = r => attempts.some(a => ((r.attemptId && a.id === r.attemptId) || (r.cid && a.client_request_id === r.cid)) && a.state === 'succeeded')
    setNewRuns(rs => rs.some(done) ? rs.filter(r => !done(r)) : rs)
  }, [data])
  addShown.current = !!data && mode === 'review' && (offAsset || versions.length === 0)
  useEffect(() => { if (!offAsset) setDropping(false) }, [offAsset])
  const ordinal = v => { const i = assetOf(v)?.items.indexOf(v) ?? -1; return i >= 0 ? `v${i + 1}` : '' }
  // A revision of this asset being generated (running, or reserved while this page sends it) is shown on the
  // stage over its parent until dismissed for that attempt; its pending strip card brings it back.
  const [genHidden, setGenHidden] = useState([])
  const stageGen = (() => {
    const a = asset && runningAttempts.find(x => x.kind === 'revision' && (x.state === 'running' || !!generating) && versions.find(v => v.id === x.parent_id)?.asset_id === asset.id)
    if (!a) return null
    const parent = versions.find(v => v.id === a.parent_id)
    return { id: a.id, parentId: parent.id, from: ordinal(parent), to: `v${asset.items.length + 1}` }
  })()
  const genShown = stageGen && mode === 'review' && selected?.id === stageGen.parentId && !genHidden.includes(stageGen.id) ? stageGen : null
  if (genShown) genShownRef.current = { id: genShown.id, parentId: genShown.parentId }
  // A version card opens that version; the parent's own card also means "the parent itself", without the progress view.
  const openTile = id => { if (genShown && id === genShown.parentId && !lock.current) setGenHidden(ids => [...ids, genShown.id]); navigateReview(id) }
  const showGen = () => { if (!stageGen || lock.current) return; setGenHidden(ids => ids.filter(x => x !== stageGen.id)); review(stageGen.parentId) }
  // "Generated v3 with Nano Banana Pro." / "Generated v3, but with X instead of Y. Check it before use."
  const madeText = a => {
    const v = versions.find(x => x.id === a.version_id), what = `Generated ${(v && ordinal(v)) || 'a new version'}`
    const by = reportedShort(a, picks.list), wanted = String(a.image_selection?.display || '').replace(/\s*\(.*\)\s*$/, '')
    if (a.selection_mismatch) return `${what}, but ${by ? `with ${by} instead of ${wanted || 'the chosen model'}` : `not with ${wanted || 'the chosen model'}`}. Check it before use.`
    return `${what}${by ? ` with ${by}` : ''}.`
  }
  // Where a version came from, as short tags ("↳ v1", then "Upload" or the REPORTED model's short name);
  // the full origin text is the tags' tooltip.
  const originOf = v => {
    const a = attempts.find(x => x.state === 'succeeded' && x.version_id === v.id) || null
    const generated = v.origin === 'generated' || !!a
    const model = generated ? reportedShort(a, picks.list) : ''
    const p = v.parent_id ? versions.find(x => x.id === v.parent_id) : null
    const from = v.parent_id ? `from ${p ? ordinal(p) || p.name : 'an earlier version'}` : ''
    const by = a ? reportedOf(a) : ''
    const tags = [p ? { kind: 'parent', text: `↳ ${ordinal(p) || p.name}` } : null,
      generated ? { kind: 'model', text: model || 'Generated' } : { kind: 'upload', text: 'Upload' }].filter(Boolean)
    return { tags, title: `${generated ? 'Generated' : 'Uploaded'}${from ? ` ${from}` : ' · first version'}${by ? ` · reported ${by}` : ''}` }
  }
  const openVersion = id => { if (lock.current || !versions.some(v => v.id === id)) return; setComposer(false); review(id) }
  const compareWithParent = (parentId, id) => { if (lock.current) return; setCompare([parentId, id]); setMode('compare') }
  const checkStatus = () => { detail.refetch() } // read-only re-read; never dispatches or retries
  const openComposer = () => { if (lock.current) return; composerFrom.current = document.activeElement; setComposer(true); setMode('review') }
  const closeComposer = () => {
    setComposer(false)
    const from = composerFrom.current; composerFrom.current = null
    setTimeout(() => (from?.isConnected ? from : root.current?.querySelector('.rt-new-half[data-kind=generate]'))?.focus?.(), 0)
  }
  // Generate in the composer: it closes and a card waits in All assets while the same confirmed request runs.
  const sendNew = spec => {
    if (genLock.current || lock.current || !pid) return
    const key = requestId(), projectId = pid
    setNewRuns(rs => [...rs, { key, projectId, title: shortTitle(spec.prompt), cid: '', attemptId: '', error: '' }])
    const track = patch => {
      if (!mounted.current) return
      setNewRuns(rs => rs.flatMap(r => r.key !== key ? [r] : patch.drop || (patch.done && !r.attemptId && !r.error) ? [] : patch.done ? [r] : [{ ...r, ...patch }]))
    }
    closeComposer()
    runGeneration(spec, track)
  }
  const dismissRun = key => setNewRuns(rs => rs.filter(r => r.key !== key))
  // Revision is requested from the Review inspector: bring its first field into view and focus it.
  const focusRevision = () => {
    if (lock.current) return; setComposer(false); setMode('review'); setTab('request')
    setTimeout(() => { const t = root.current?.querySelector('textarea[aria-label="What should change?"]'); if (t) { t.scrollIntoView({ block: 'center' }); t.focus({ preventScroll: true }) } }, 0)
  }
  const genProps = { gen, route, generating, blocked: genBlocked, onGenerate: runGeneration, picks, recent: models.recent, lastModel: models.last, pickModel, attempts, onOpen: openVersion, onCompare: compareWithParent, onCheck: checkStatus, onSend: sendReserved, onCancel: cancelReserved }
  useEffect(() => { if (selected) viewed.current.set(selected.asset_id, selected.id) }, [selected?.id])
  // Only choose a default when no explicit version was requested. A post-upload ID can
  // arrive before the refreshed detail payload; never replace it with an older take.
  useEffect(() => { if (data && versions.length && !active && !lock.current) setActive(versions[versions.length - 1].id) }, [data, versions.length, active])

  const review = id => { setActive(id); setMode('review'); setView('asset') } // internal, e.g. post-upload auto-selection
  const navigateReview = id => { if (!lock.current) review(id) }
  const chooseMode = m => { if (!lock.current) setMode(m) }
  // A mode change remounts the stage header, and leaving Lineage unmounts the focused node: focus lands on the
  // switch's current choice instead of <body>.
  const prevMode = useRef(mode)
  useEffect(() => {
    const was = prevMode.current; prevMode.current = mode
    if (was !== mode) setTimeout(() => { const a = document.activeElement; if (!a || a === document.body || !a.isConnected) root.current?.querySelector('.rt-modes [aria-checked=true]')?.focus({ preventScroll: true }) }, 0)
  }, [mode])
  // A pick in the floating (narrow) panel folds it away again.
  const foldPanel = () => { if (narrow) setPanelPref(null) }
  const chooseAsset = id => { if (lock.current) return; const a = assets.find(x => x.id === id); if (!a) return; const last = viewed.current.get(id); setActive(a.items.some(v => v.id === last) ? last : faceOf(a).id); setMode('review'); setView('asset'); foldPanel() }
  const toOverview = () => { if (lock.current) return; setComposer(false); setMode('review'); setView('overview'); foldPanel() }
  const toVersions = () => { if (lock.current) return; setComposer(false); setMode('review'); setView('versions'); foldPanel() }
  const openFromAll = id => { if (lock.current) return; setComposer(false); review(id); foldPanel() }
  const switchProject = id => { if (lock.current) return; setPid(id); setActive(''); setCompare([]); setMode('review'); setView('overview'); setQuery(''); setMenu(null); setRenamingProject(''); setDeleting(null); clearOk(); foldPanel() }
  // Deletion is one explicit, confirmed DELETE through the profile router; the backend refuses (changing
  // nothing) while any attempt is reserved, running or of unknown outcome.
  const deleteProject = async target => {
    if (!target || lock.current || !current()) return
    lock.current = true; setSaving(true); clearOk(); setDeleteError('')
    try {
      scope.assert()
      await ctx.rest(`/projects/${enc(target.id)}`, { method: 'DELETE', body: { confirm_name: target.name } })
      scope.assert()
      setDeleting(null)
      if (projectRef.current === target.id) { setPid(''); setActive(''); setCompare([]); setView('overview') }
      await client.invalidateQueries({ queryKey: scope.key })
      if (current()) setMessage({ kind: 'ok', head: 'Deleted. ', text: `Project “${target.name}” and everything in it were removed.` })
    } catch (e) { if (current()) setDeleteError(text(e)) } finally { lock.current = false; if (current()) setSaving(false) }
  }
  // Page keys: ←/→ step through the open asset's versions in strip order; Escape closes the project menu,
  // the delete dialog or the floating project panel. Widgets that own these keys (fields, radio groups, menus) go first.
  const pageKeys = useRef(null)
  pageKeys.current = e => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || typingIn(e.target)) return
    const inside = !e.target || e.target === document.body || root.current?.contains(e.target)
    if (!inside) return
    if (e.key === 'Escape') {
      if (deleting) { if (!busy) { e.preventDefault(); setDeleting(null) } }
      else if (menu) { e.preventDefault(); setMenu(null) }
      else if (panelFloat && root.current?.querySelector('.rt-panel')?.contains(e.target)) { e.preventDefault(); setPanelPref(null); root.current?.querySelector('.rt-panel-toggle')?.focus() }
      else if (mode === 'lineage' && !lock.current) { e.preventDefault(); setMode('review') }
      return
    }
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key]
    // S sets or unsets the viewed version as Main; X hides or unhides it.
    const markKey = { s: toggleMain, x: toggleHidden }[e.key.toLowerCase()]
    if (markKey && !step) {
      if (e.repeat) { e.preventDefault(); return } // a held key acts once
      if (mode !== 'review' || offAsset || !selected || !asset || deleting || menu || busy || lock.current) return
      if (e.target?.closest?.('[role=radiogroup],[role=tablist],[role=menu],video,audio') || root.current?.querySelector('[role=menu],.rt-overlay')) return
      e.preventDefault()
      act(markJob(selected, markKey(selected), ordinal, versions))
      return
    }
    if (!step || (mode !== 'review' && mode !== 'lineage') || offAsset || !selected || !asset || deleting || menu) return
    if (e.target?.closest?.('[role=radiogroup],[role=tablist],[role=menu],video,audio') || root.current?.querySelector('[role=menu],.rt-overlay')) return
    const next = stripItems[stripItems.indexOf(selected) + step]
    e.preventDefault()
    if (!next || lock.current) return
    // Lineage: the arrows move the selection and keep Lineage open.
    if (mode === 'lineage') { setActive(next.id); setTimeout(() => root.current?.querySelector('.rt-lin-node[data-active=true] button')?.focus({ preventScroll: true }), 0); return }
    const fromVersions = !!e.target?.closest?.('.rt-frame')
    navigateReview(next.id)
    setTimeout(() => {
      const tile = root.current?.querySelector('.rt-frame[data-active=true]')
      tile?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
      if (fromVersions) tile?.querySelector('button')?.focus()
    }, 0)
  }
  useEffect(() => { const on = e => pageKeys.current?.(e); document.addEventListener('keydown', on); return () => document.removeEventListener('keydown', on) }, [])
  // Full view of the reviewed version; stepping in it moves the review too, so closing lands on the same version.
  const lightboxOn = lightbox && mode === 'review' && !offAsset && !!selected && !!asset
  const openLightbox = () => { lightboxFrom.current = document.activeElement; setLightbox(true) }
  const closeLightbox = () => {
    setLightbox(false)
    const from = lightboxFrom.current; lightboxFrom.current = null
    // The opener, or (when the full view moved to another version) that version's ⤢ once its media is shown.
    const back = n => { const t = from?.isConnected ? from : root.current?.querySelector('.rt-zoom-full'); if (t) t.focus?.(); else if (n < 40) setTimeout(() => back(n + 1), 25) }
    setTimeout(() => back(0), 0)
  }
  useEffect(() => { if (lightbox && !lightboxOn) setLightbox(false) }, [lightbox, lightboxOn])
  const stepLightbox = d => { const next = stripItems[stripItems.indexOf(selected) + d]; if (next && !lock.current) review(next.id) }
  const pairHere = compare.length === 2 && !!asset && compare.some(id => asset.items.some(v => v.id === id))
  // Opening another asset clears a pair that has no version in it (its ticks are not on screen there, yet would fill both slots).
  useEffect(() => { if (compare.length === 2 && asset && !pairHere) setCompare([]) }, [asset?.id])
  const toggleCompare = (id, checked) => setCompare(ids => checked ? [...ids.filter(x => x !== id), id].slice(0, 2) : ids.filter(x => x !== id))
  const list = projects.data?.projects || []

  // Focus a node that may only appear after the next render (the rail once projects load, the New project field).
  const focusSoon = (find, n = 0) => { const t = typeof find === 'function' ? find() : root.current?.querySelector(find); if (t) t.focus(); else if (n < 80) setTimeout(() => focusSoon(find, n + 1), 25) }
  // Open project…: focus the open project's cover in the rail (else the first one); ↑/↓ then move between projects.
  const focusRail = () => focusSoon(() => root.current?.querySelector('.rt-proj[aria-current=true]') || root.current?.querySelector('.rt-proj'))
  // New project: a small form beside the rail's +, anchored to the root so the rail never clips it.
  const startNewProject = () => {
    const plus = root.current?.querySelector('.rt-rail-new')
    if (!plus) return
    const r = plus.getBoundingClientRect(), box = root.current.getBoundingClientRect()
    setMenu(null)
    setCreating({ top: Math.max(8, Math.min(r.top - box.top, box.height - 120)) })
    setTimeout(() => focusSoon('#retake-new-project'), 0)
  }
  // Palette rows run while Hermes' palette still holds focus; act once it has closed and handed focus back.
  const fromPalette = useRef(null)
  fromPalette.current = kind => {
    const outside = () => [...document.querySelectorAll('[role=dialog]')].some(d => !root.current?.contains(d))
    const go = n => { if (!mounted.current) return; if (outside() && n < 60) return setTimeout(() => go(n + 1), 25); setTimeout(() => kind === 'new' ? startNewProject() : focusRail(), 0) }
    go(0)
  }
  useEffect(() => {
    const on = kind => fromPalette.current?.(kind)
    pageRequests.pages.add(on)
    if (pageRequests.pending) { const kind = pageRequests.pending; pageRequests.pending = null; on(kind) }
    return () => { pageRequests.pages.delete(on) }
  }, [])

  // A press outside closes the New project form (discarding the name) and the floating project panel.
  useEffect(() => {
    if (!creating && !panelFloat) return
    const down = e => {
      const r = root.current, inside = sel => !!r?.querySelector(sel)?.contains(e.target)
      if (!r) return
      if (creating && !inside('.rt-new') && !inside('.rt-rail-new') && !inside('.rt-toasts')) { setCreating(null); setProjectName('') }
      if (panelFloat && !inside('.rt-panel') && !inside('.rt-panel-toggle') && !inside('.rt-menu') && !inside('.rt-overlay')) setPanelPref(null)
    }
    document.addEventListener('pointerdown', down)
    return () => document.removeEventListener('pointerdown', down)
  }, [creating, panelFloat])

  // The open project's actions (in the panel head). The menu is anchored to the Retake root so it is never clipped.
  const openProjectMenu = (p, button) => {
    if (menu?.id === p.id) return setMenu(null)
    const r = button.getBoundingClientRect(), box = root.current.getBoundingClientRect()
    setMenu({ id: p.id, top: r.bottom - box.top + 4, left: Math.max(8, Math.min(r.left - box.left, box.width - 188)) })
  }
  const saveProjectName = (p, value) => { setRenamingProject(''); const name = value.trim(); if (!name || name === p.name) return; act({ path: `/projects/${enc(p.id)}/name`, body: { name } }) }
  const projectMenu = () => {
    const p = list.find(x => x.id === menu?.id) || (menu && data?.project.id === menu.id ? data.project : null)
    if (!p) return null
    // Only the open project's attempts are known here; for another project the server's refusal shows in the dialog.
    const blocked = data?.project.id === p.id && openAttempts > 0
    const trigger = () => [...(root.current?.querySelectorAll('[data-proj-menu]') || [])].find(b => b.dataset.projMenu === p.id)
    return el('div', { key: 'proj-menu', className: 'rt-menu', role: 'menu', 'aria-label': `Actions for ${p.name}`, style: { top: menu.top, left: menu.left },
      onKeyDown: e => { if (e.key === 'Escape') { e.preventDefault(); setMenu(null); trigger()?.focus() } },
      onBlur: e => { const t = e.relatedTarget; if (!e.currentTarget.contains(t) && t !== trigger()) setMenu(null) } },
      el('button', { type: 'button', role: 'menuitem', autoFocus: true, onClick: () => { setMenu(null); setRenamingProject(p.id) } }, 'Rename…'),
      el('button', { type: 'button', role: 'menuitem', disabled: blocked, 'aria-describedby': blocked ? 'retake-delete-why' : undefined, onClick: () => { setMenu(null); setDeleting({ id: p.id, name: p.name }) } }, 'Delete project…'),
      blocked ? el('span', { id: 'retake-delete-why', className: 'rt-menu-why' }, 'Unavailable while a generation is in progress.') : null)
  }

  const sep = key => el('span', { key, className: 'rt-sep', 'aria-hidden': 'true' }, '›')
  const header = el('header', { className: 'rt-top' },
    // Narrow routes fold the project panel; this brings it back over the work area.
    pid && narrow ? el('button', { type: 'button', className: 'rt-icon rt-panel-toggle', 'aria-label': 'Project panel', title: 'Project panel', 'aria-expanded': panelOpen, 'aria-controls': 'retake-panel',
      onClick: () => setPanelPref(panelOpen ? 'closed' : 'open') }, icon(ICON.panel)) : null,
    // Plain links: Retake (all projects) › project (All assets) › the asset or All versions (the current page).
    el('nav', { className: 'rt-crumbs', 'aria-label': 'Breadcrumb' },
      // The root crumb is the page heading: it names the app and leads back to every project.
      el('h1', {}, el('button', { type: 'button', className: 'rt-crumb', disabled: busy, 'aria-current': pid ? undefined : 'page', onClick: () => switchProject('') }, 'Retake')),
      data ? [sep('s1'), el('button', { key: 'p', type: 'button', className: 'rt-crumb rt-crumb-p', disabled: busy, title: data.project.name, 'aria-current': showOverview ? 'page' : undefined, onClick: toOverview }, data.project.name)] : null,
      data && showVersions ? [sep('s2'), el('span', { key: 'a', className: 'rt-trunc rt-asset-name', 'aria-current': 'page' }, 'All versions')] : null,
      data && asset && !offAsset ? [sep('s2'), el('span', { key: 'a', className: 'rt-trunc rt-asset-name', title: asset.label, 'aria-current': 'page' }, asset.label)] : null),
    el('div', { className: 'rt-top-tools' },
      here ? el('span', { className: 'rt-scope', title: 'Hermes connection · profile' }, here) : null,
      pid ? el('button', { type: 'button', className: 'rt-icon', 'aria-label': 'Refresh', title: 'Refresh project', disabled: busy, onClick: () => detail.refetch() }, icon(ICON.refresh)) : null))

  // Rail: All projects, a cover per project (the open one outlined; name in the tooltip), then New project.
  // One tab stop per button; ↑/↓, Home and End move between them.
  const railKeys = e => {
    const move = { ArrowDown: 1, ArrowUp: -1 }[e.key], edge = { Home: 0, End: -1 }[e.key]
    if ((move === undefined && edge === undefined) || e.altKey || e.ctrlKey || e.metaKey) return
    const items = [...e.currentTarget.querySelectorAll('button:not(:disabled)')], i = items.indexOf(e.target)
    if (i < 0) return
    e.preventDefault()
    items[move !== undefined ? (i + move + items.length) % items.length : (edge + items.length) % items.length]?.focus()
  }
  const rail = el('aside', { className: 'rt-rail', 'aria-label': 'Projects', onKeyDown: railKeys },
    el('button', { type: 'button', className: 'rt-icon rt-rail-btn', 'aria-label': 'All projects', title: 'All projects', 'aria-current': pid ? undefined : 'page', disabled: busy, onClick: () => switchProject('') }, icon(ICON.grid)),
    projects.error ? el('p', { className: 'rt-sr' }, `Could not load projects: ${text(projects.error)}`) : null,
    projects.isPending ? el('p', { role: 'status', className: 'rt-sr' }, 'Loading projects…') : null,
    list.length ? el('ul', { className: 'rt-projects' }, ...list.map(p => el('li', { key: p.id },
      el('button', { type: 'button', className: 'rt-proj', disabled: busy, 'aria-current': p.id === pid ? 'true' : undefined, 'aria-label': p.name, title: p.name, onClick: () => p.id === pid ? toOverview() : switchProject(p.id) },
        h(Cover, { scope, project: p }))))) : null,
    el('button', { type: 'button', className: 'rt-icon rt-rail-btn rt-rail-new', 'aria-label': 'New project', title: 'New project', 'aria-expanded': !!creating, disabled: busy, onClick: () => creating ? cancelNew() : startNewProject() }, icon(ICON.plus)))
  // Enter or Create makes the project; Escape or Cancel closes the form.
  const newProjectForm = creating ? el('form', { key: 'new-project', className: 'rt-new', 'aria-label': 'New project', style: { top: creating.top, left: RAIL_W + 6 },
    onSubmit: e => { e.preventDefault(); if (projectName.trim()) act({ path: '/projects', body: { name: projectName.trim() }, after: p => { setPid(p.id); setActive(''); setCompare([]); setMode('review'); setView('overview'); setQuery(''); setProjectName(''); setCreating(null) } }) },
    onKeyDown: e => { if (e.key === 'Escape') { e.preventDefault(); cancelNew() } } },
    h(Input, { id: 'retake-new-project', 'aria-label': 'New project name', placeholder: 'Project name', value: projectName, maxLength: 120, required: true, autoFocus: true, autoComplete: 'off', onChange: e => setProjectName(e.target.value) }),
    el('div', { className: 'rt-row rt-end' },
      btn('Cancel', cancelNew, { disabled: busy }),
      el(Button, { type: 'submit', disabled: busy || !projectName.trim(), size: 'sm' }, 'Create'))) : null

  // Project panel: name and its actions, search, All assets, All versions, then the (matching) assets.
  const panelProject = data?.project || list.find(x => x.id === pid) || null
  const pitem = (label, glyph, count, on, onClick) => el('li', { key: label }, el('button', { type: 'button', className: 'rt-pitem', 'aria-current': on ? 'page' : undefined, disabled: busy || !data, onClick },
    icon(glyph), el('span', { className: 'rt-pitem-name' }, label), el('span', { className: 'rt-pitem-n', 'aria-hidden': 'true' }, count)))
  const panel = panelOpen && panelProject ? el('nav', { className: 'rt-panel', id: 'retake-panel', 'aria-label': 'Project', 'data-float': panelFloat ? 'true' : undefined },
    el('div', { className: 'rt-panel-head' },
      renamingProject === pid
        // Renaming swaps the name for a field: Enter or leaving the field saves, Escape cancels; empty or unchanged sends nothing.
        ? el('input', { className: 'rt-rename', 'aria-label': `Name for ${panelProject.name}`, defaultValue: panelProject.name, maxLength: 120, autoFocus: true,
          onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } else if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.dataset.cancel = '1'; setRenamingProject('') } },
          onBlur: e => { if (!e.currentTarget.dataset.cancel) saveProjectName(panelProject, e.currentTarget.value) } })
        : el('h2', { className: 'rt-trunc', title: panelProject.name }, panelProject.name),
      renamingProject === pid ? null : el('button', { type: 'button', className: 'rt-icon', 'data-proj-menu': pid, 'aria-label': `Actions for ${panelProject.name}`, 'aria-haspopup': 'menu', 'aria-expanded': menu?.id === pid, disabled: busy,
        onClick: e => openProjectMenu(panelProject, e.currentTarget) }, icon(ICON.more))),
    h(Input, { type: 'search', className: 'rt-search', 'aria-label': 'Search this project', placeholder: 'Search this project', value: query, autoComplete: 'off', spellCheck: false, disabled: !data,
      onChange: e => setQuery(e.target.value),
      onKeyDown: e => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        if (query) setQuery('')
        else if (panelFloat) { setPanelPref(null); root.current?.querySelector('.rt-panel-toggle')?.focus() }
      } }),
    el('ul', { className: 'rt-pnav' },
      pitem('All assets', ICON.grid, assets.length, showOverview, toOverview),
      pitem('All versions', ICON.list, hits ? hits.size : versions.length, showVersions, toVersions)),
    assets.length ? el('h3', { className: 'rt-eyebrow', id: 'retake-panel-assets' }, 'Assets') : null,
    assets.length ? el('ul', { className: 'rt-pnav', 'aria-labelledby': 'retake-panel-assets' }, ...foundAssets.map(a => el('li', { key: a.id },
      el('button', { type: 'button', className: 'rt-pitem', disabled: busy, title: a.label, 'aria-current': !offAsset && asset?.id === a.id && !!selected ? 'page' : undefined, onClick: () => chooseAsset(a.id) },
        h(Thumb, { scope, version: faceOf(a), fallback: '' }), el('span', { className: 'rt-pitem-name' }, a.label))))) : null,
    hits && !foundAssets.length ? el('p', { className: 'rt-muted', role: 'status' }, 'No match') : null) : null

  const emptyMain = (key, ...content) => el('section', { key, className: 'rt-main rt-main-empty' }, ...content)
  // Shared empty / loading / error block: title, one sentence, optional actions.
  const emptyBox = ({ title, body, actions, kind, role }) => el('div', { className: 'rt-empty', 'data-kind': kind, role },
    kind === 'loading' ? el('span', { className: 'rt-spin', 'aria-hidden': 'true' }) : null,
    title ? el('p', { className: 'rt-empty-title' }, title) : null, body ? el('p', {}, body) : null,
    actions ? el('div', { className: 'rt-row' }, actions) : null)
  // Empty project: two choices. The upload tile is the file input's label and a drop target; both feed the same
  // JSON upload (type and size checked before any request) and open the new version.
  const uploadNew = f => { if (f) act({ path: `/projects/${enc(pid)}/versions`, file: f, after: v => review(v.id) }) }
  const dragOver = (e, on) => { e.preventDefault(); if (on || !e.currentTarget.contains(e.relatedTarget)) e.currentTarget.dataset.over = on ? 'true' : 'false' }
  // Generate's state on the New asset tile and the empty project: still checking stays clickable (the composer says
  // "Checking…"); a failed check offers Retry; "unavailable" shows the backend's reason under the label.
  const genOff = !gen.available && !gen.checking && !gen.failed
  const genWhy = () => el('small', { id: 'retake-gen-why', className: 'rt-new-why' }, gen.reason || 'Image generation is not available for this profile.')
  const capsRetry = () => el('button', { type: 'button', className: 'rt-new-retry', 'aria-describedby': 'retake-gen-why', onClick: () => capsQuery.refetch() }, 'Retry')
  const guide = () => emptyMain('guide', el('div', { className: 'rt-start' },
    el('h3', {}, 'Add your first asset'),
    el('div', { className: 'rt-choices' },
      el('label', { className: 'rt-choice rt-choice-drop', tabIndex: busy ? -1 : 0, 'data-disabled': busy ? 'true' : undefined,
        onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.querySelector('input')?.click() } },
        onDragOver: e => dragOver(e, true), onDragLeave: e => dragOver(e, false),
        onDrop: e => { dragOver(e, false); if (!busy) uploadNew(e.dataTransfer?.files?.[0]) } },
        el('span', { className: 'rt-choice-ic', 'aria-hidden': 'true' }, icon(ICON.upload)), el('b', {}, busy ? 'Saving…' : 'Upload a file'), el('small', {}, `or drop it here · ${UPLOAD_KINDS}`),
        el('input', { type: 'file', accept: UPLOAD_ACCEPT, 'aria-label': 'Upload a new asset', tabIndex: -1, disabled: busy, onChange: e => { const f = e.target.files?.[0]; e.target.value = ''; uploadNew(f) } })),
      gen.failed ? el('div', { className: 'rt-choice', 'data-state': 'failed' },
        el('span', { className: 'rt-choice-ic', 'aria-hidden': 'true' }, icon(ICON.spark)), el('small', { id: 'retake-gen-why', role: 'status' }, CAPS_FAILED), capsRetry())
        : el('button', { type: 'button', className: 'rt-choice', 'aria-label': 'Generate from a prompt', disabled: genOff || busy, 'aria-describedby': genOff ? 'retake-gen-why' : undefined, onClick: openComposer },
          el('span', { className: 'rt-choice-ic', 'aria-hidden': 'true' }, icon(ICON.spark)), el('b', {}, 'Generate from a prompt'), genOff ? genWhy() : null)),
    el('ol', { className: 'rt-flow', 'aria-label': 'How it works' }, el('li', {}, 'Add an asset'), el('li', {}, 'Mark notes on it'), el('li', {}, 'Make the next version'))))

  const figure = (id, i) => {
    const v = versions.find(x => x.id === id)
    if (!v) return el('div', { key: `slot-${i}`, className: 'rt-slot' }, el('span', { className: 'rt-badge', 'aria-hidden': 'true' }, 'AB'[i]), `Choose version ${'AB'[i]} with its A/B chip in the filmstrip.`)
    // Caption: "A v2 filename · status" on one line; one muted line with the relation (by ordinal, not a repeated
    // filename) and file facts. The asset is named only when the two versions belong to different assets.
    const p = v.parent_id ? versions.find(x => x.id === v.parent_id) : null
    const rel = !v.parent_id ? 'Original' : p ? `Revision of ${ordinal(p) || p.name}` : 'Revision'
    const pair = compare.map(x => versions.find(y => y.id === x)).filter(Boolean)
    const crossAsset = new Set(pair.map(x => x.asset_id)).size > 1
    const meta = [crossAsset ? assetOf(v)?.label || shortId(v.asset_id) : '', rel, facts(v)].filter(Boolean).join(' · ')
    return el('figure', { key: id, className: 'rt-fig', 'aria-label': `Version ${'AB'[i]}: ${v.name}` },
      el('div', { className: 'rt-fig-frame' }, h(Media, { scope, version: v, variant: 'compare' })),
      el('figcaption', {},
        el('div', { className: 'rt-row' }, el('span', { className: 'rt-badge' }, 'AB'[i]), el('strong', { className: 'rt-fig-v', title: 'Display order within this asset (not stored)' }, ordinal(v) || 'v?'), mark(v), h(Download, { scope, version: v, compact: true })),
        el('span', { className: 'rt-muted rt-trunc rt-fig-rel', title: [lineage(v, versions), `Asset · ${assetOf(v)?.label || shortId(v.asset_id)}`, facts(v)].join(' · ') }, meta),
        el('span', { className: 'rt-id rt-fig-id' }, v.id)))
  }
  // Two images can also be stacked in one box (Swipe, Overlay); video and a half-chosen pair stay side by side.
  const pair = compare.map(id => versions.find(v => v.id === id))
  const stackable = pair.length === 2 && pair.every(v => v && v.mime !== 'video/mp4')
  const cmpShown = stackable ? cmpView : 'side'
  const pairLabels = stackable ? (([a, b]) => a && a === b ? [`A ${a}`, `B ${b}`] : [a || 'A', b || 'B'])(pair.map(v => ordinal(v))) : []
  // Compare from the switch: the two ticked versions, else the selected one against its parent, else the version
  // before it (after it, for the first); an asset with one version and nothing ticked has nothing to compare.
  const compareOther = () => {
    if (!selected || !asset) return null
    const items = asset.items, i = items.indexOf(selected)
    return versions.find(v => v.id === selected.parent_id && v.id !== selected.id) || items[i - 1] || items[i + 1] || null
  }
  // A ticked pair counts here only while one of its versions belongs to the open asset; a pair left from another asset is ignored.
  const pickMode = m => {
    if (lock.current || m === mode) return
    if (m === 'compare' && !pairHere) { const o = compareOther(); if (!o) return; setCompare([o.id, selected.id]) }
    setMode(m)
  }
  const modeSwitch = selected && asset ? h(ModeSwitch, { mode, onPick: pickMode, off: !pairHere && !compareOther() ? { compare: 'Only one version' } : {} }) : null
  const comparison = el('section', { key: 'compare', className: 'rt-main', 'aria-label': 'Compare versions' },
    el('header', { className: 'rt-bar' },
      el('div', { className: 'rt-bar-title' }, modeSwitch || btn(`← Back to ${selected ? ordinal(selected) || 'review' : 'review'}`, () => chooseMode('review'), { className: 'rt-back' }), el('h3', { className: 'rt-sr' }, 'Compare')),
      el('div', { className: 'rt-cmp-tools' },
        stackable ? el('div', { className: 'rt-view', role: 'group', 'aria-label': 'Compare view' },
          ...[['side', 'Side by side'], ['swipe', 'Swipe'], ['overlay', 'Overlay']].map(([k, label]) => el('button', { key: k, type: 'button', 'aria-pressed': cmpShown === k, onClick: () => setCmpView(k) }, label))) : null,
        compare.length ? el(Button, { type: 'button', variant: 'outline', size: 'sm', className: 'rt-cmp-clear', 'aria-label': 'Clear comparison', title: 'Clear comparison', onClick: () => setCompare([]) }, icon(ICON.x), el('span', {}, 'Clear comparison')) : null)),
    cmpShown === 'side' ? el('div', { className: 'rt-cmp' }, figure(compare[0], 0), figure(compare[1], 1))
      : h(CompareStack, { key: `${pair[0].id}:${pair[1].id}`, scope, a: pair[0], b: pair[1], mode: cmpShown, labels: pairLabels }))

  // Lineage: the asset's shown versions (hidden ones left out unless shown), each linked to the nearest shown
  // version it descends from; a link that skips a hidden version is dashed.
  const lineageView = () => {
    const shown = new Set(stripItems.map(v => v.id)), byId = new Map(asset.items.map(v => [v.id, v])), skipped = new Set()
    const up = v => {
      const seen = new Set([v.id])
      for (let p = byId.get(v.parent_id); p && !seen.has(p.id); p = byId.get(p.parent_id)) { if (shown.has(p.id)) { if (p.id !== v.parent_id) skipped.add(v.id); return p.id } seen.add(p.id) }
      return null
    }
    const layout = lineageLayout(stripItems, up)
    return h(Lineage, { key: `lineage-${asset.id}`, scope, items: stripItems, layout, skipped, path: new Set(trailOf(selected, asset.items).map(v => v.id)), current: selected.id, ordinalOf: ordinal, originOf,
      onSelect: id => { if (!lock.current) setActive(id) }, onOpen: navigateReview,
      lead: modeSwitch,
      tools: hiddenCount ? el('div', { className: 'rt-view rt-lin-hidden' }, el('button', { type: 'button', 'aria-pressed': showHidden, onClick: () => setShowHidden(!showHidden) }, icon(ICON.eyeClosed), 'Show hidden')) : null })
  }
  // Assets are the project's contents; versions belong to one asset. Each card opens that asset's versions.
  const saveName = (a, value) => { setRenaming(''); const name = value.trim(); if (name === (a.named ? a.label : '')) return; act({ path: `/projects/${enc(pid)}/assets/${enc(a.id)}/name`, body: { name } }) }
  const assetCard = a => {
    const face = faceOf(a), pick = pickOf(a)
    const meta = el('span', { className: 'rt-asset-meta' }, el('span', {}, plural(a.items.length, 'version')), pick ? el('span', { key: 'm', className: 'rt-flag', 'data-mark': 'main', title: `Main · ${ordinal(pick)}` }, icon(ICON.star, true), ordinal(pick)) : null)
    // Renaming swaps the card's title for a field: Enter or leaving the field saves, Escape cancels, empty restores the default.
    if (renaming === a.id) return el('li', { key: a.id }, el('div', { className: 'rt-asset-card', 'data-editing': 'true' },
      h(Thumb, { scope, version: face }),
      el('span', { className: 'rt-asset-text' },
        el('input', { className: 'rt-rename', 'aria-label': `Name for ${a.label}`, defaultValue: a.named ? a.label : '', placeholder: a.label, maxLength: 120, autoFocus: true,
          onKeyDown: e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } else if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.dataset.cancel = '1'; setRenaming('') } },
          onBlur: e => { if (!e.currentTarget.dataset.cancel) saveName(a, e.currentTarget.value) } }), meta)))
    // The Main represents the asset; without one, the latest version that is not hidden does.
    return el('li', { key: a.id, className: 'rt-asset-item' },
      el('button', { type: 'button', className: 'rt-asset-card', disabled: busy, 'aria-label': `Open ${a.label}`, title: `${a.label} · ${plural(a.items.length, 'version')} · ${a.root.name}`, onClick: () => chooseAsset(a.id) },
        h(Thumb, { scope, version: face }),
        el('span', { className: 'rt-asset-text' }, el('strong', { className: 'rt-trunc' }, a.label), meta)),
      el('button', { type: 'button', className: 'rt-icon rt-rename-btn', disabled: busy, 'aria-label': `Rename ${a.label}`, title: 'Rename', onClick: () => setRenaming(a.id) }, icon(ICON.edit)))
  }
  // First card: Upload | Generate. While a file is dragged over All assets it is one "Drop to add" target; a drop
  // anywhere on the page goes through the same JSON upload (type and size checked before any request).
  const newAssetCard = () => el('li', { key: 'new', className: 'rt-asset-item' },
    // Sized like a card (padding, 4:3 thumbnail, text) so the tile matches the cards beside it, also alone in a row.
    el('span', { className: 'rt-new-sizer', 'aria-hidden': 'true' }),
    // The file input lives outside the buttons: a real file dialog takes window focus, and an input
    // unmounted meanwhile (e.g. by a drag state) would drop the file silently.
    el('input', { ref: newFile, type: 'file', className: 'rt-sr', accept: UPLOAD_ACCEPT, 'aria-label': 'Upload a new asset', tabIndex: -1,
      onChange: e => { const f = e.target.files?.[0]; e.target.value = ''; uploadNew(f) } }),
    dropping
      ? el('div', { className: 'rt-new-tile', 'data-drop': 'true' }, el('span', { className: 'rt-new-half' }, busy ? 'Saving…' : 'Drop to add'))
      : el('div', { className: 'rt-new-tile', role: 'group', 'aria-label': 'New asset' },
        el('button', { type: 'button', className: 'rt-new-half', 'data-kind': 'upload', disabled: busy, onClick: () => newFile.current?.click() }, icon(ICON.upload), busy ? 'Saving…' : 'Upload'),
        gen.failed ? el('div', { className: 'rt-new-half', 'data-kind': 'generate', 'data-state': 'failed' }, el('span', { id: 'retake-gen-why', className: 'rt-new-why', role: 'status' }, CAPS_FAILED), capsRetry())
          : el('button', { type: 'button', className: 'rt-new-half', 'data-kind': 'generate', 'aria-label': 'Generate', disabled: genOff, 'aria-describedby': genOff ? 'retake-gen-why' : undefined, onClick: openComposer },
            icon(ICON.spark), 'Generate', genOff ? genWhy() : null)))
  const pendingCard = a => el('li', { key: `attempt-${a.id}` }, el('div', { className: 'rt-asset-card', 'data-attempt': a.state, title: `Generation attempt ${a.id}` },
    el('span', { className: 'rt-thumb' }, a.state === 'reserved' ? 'Reserved…' : el('span', { className: 'rt-spin', 'aria-hidden': 'true' })),
    el('span', { className: 'rt-asset-text' }, el('strong', {}, a.state === 'reserved' ? 'Reserved' : 'Generating…'), el('span', { className: 'rt-muted' }, 'New asset'))))
  // A new asset sent from the composer: "Generating…" while its attempt runs; the failure once it settles without one.
  // Its attempt is known by ID once the reservation answers, and by request ID while that answer is pending.
  const runAttempt = r => attempts.find(x => (r.attemptId && x.id === r.attemptId) || (r.cid && x.client_request_id === r.cid)) || null
  const runState = r => {
    const a = runAttempt(r)
    if (a?.state === 'succeeded') return null
    if (r.error) return { fail: r.error }
    if (!a || a.state === 'running' || (a.state === 'reserved' && generating)) return { fail: '' }
    const msg = a.error?.message ? ` ${String(a.error.message)}` : ''
    return { fail: a.state === 'unknown' ? `Outcome unknown.${msg}` : a.state === 'reserved' ? 'Reserved · not sent yet.' : `No version created.${msg}` }
  }
  const myRuns = newRuns.filter(r => r.projectId === pid).flatMap(r => { const st = runState(r); return st ? [{ ...r, ...st, attemptId: runAttempt(r)?.id || r.attemptId }] : [] })
  const runCard = r => el('li', { key: `run-${r.key}`, className: 'rt-asset-item' },
    el('div', { className: 'rt-asset-card rt-run-card', 'data-attempt': r.fail ? 'failed' : 'running', role: 'group', 'aria-label': r.title, title: r.fail || undefined },
      el('span', { className: 'rt-thumb' }, r.fail ? el('span', { className: 'rt-run-x', 'aria-hidden': 'true' }, '!') : el('span', { className: 'rt-spin', 'aria-hidden': 'true' })),
      el('span', { className: 'rt-asset-text' }, el('strong', { className: 'rt-trunc' }, r.title), el('span', { className: r.fail ? 'rt-run-fail' : 'rt-muted', role: 'status' }, r.fail || 'Generating…')),
      r.fail ? el('button', { type: 'button', className: 'rt-icon rt-rename-btn rt-run-dismiss', 'aria-label': `Dismiss ${r.title}`, title: 'Dismiss', onClick: () => dismissRun(r.key) }, icon(ICON.x)) : null))
  const tracked = new Set(myRuns.map(r => r.attemptId).filter(Boolean))
  const filesDrag = e => [...(e.dataTransfer?.types || [])].includes('Files')
  // All assets and All versions are both drop targets for a new asset.
  const dropZone = {
    'data-dropping': dropping ? 'true' : undefined,
    onDragEnter: e => { if (filesDrag(e)) { e.preventDefault(); setDropping(true) } },
    onDragOver: e => { if (!filesDrag(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = busy ? 'none' : 'copy'; if (!dropping) setDropping(true) },
    onDragLeave: e => { if (!e.currentTarget.contains(e.relatedTarget)) setDropping(false) },
    onDrop: e => { if (!filesDrag(e)) return; e.preventDefault(); setDropping(false); if (!busy) uploadNew(e.dataTransfer.files?.[0]) } }
  // New-asset runs and attempts started elsewhere wait as cards beside the New asset tile.
  const newRunCards = () => [...myRuns.map(runCard), ...runningAttempts.filter(a => a.kind === 'new_asset' && !tracked.has(a.id)).map(pendingCard)]
  const overview = () => el('section', { key: 'overview', className: 'rt-main rt-overview', 'aria-label': 'Project overview', ...dropZone },
    el('header', { className: 'rt-bar' }, el('div', { className: 'rt-bar-title' }, el('h3', {}, 'Assets'))),
    el('ul', { className: 'rt-assets', 'aria-label': 'Assets in this project' }, newAssetCard(), ...assets.map(assetCard), ...newRunCards()))
  const projectGrid = () => el('section', { key: 'projects', className: 'rt-main rt-overview', 'aria-label': 'All projects' },
    el('header', { className: 'rt-bar' }, el('div', { className: 'rt-bar-title' }, el('h3', {}, 'Projects'))),
    el('ul', { className: 'rt-assets', 'aria-label': 'Projects' }, ...list.map(p => el('li', { key: p.id }, el('button', { type: 'button', className: 'rt-asset-card', disabled: busy, 'aria-label': `Open project ${p.name}`, title: p.name, onClick: () => switchProject(p.id) },
      h(Cover, { scope, project: p }), el('span', { className: 'rt-asset-text' }, el('strong', { className: 'rt-trunc' }, p.name)))))))
  // All versions: every version of the project (narrowed by the search), grouped under its asset or newest first.
  // A tile opens that version in Review.
  const versionTile = (v, withAsset) => {
    const a = assetOf(v)
    return el('li', { key: v.id }, el('button', { type: 'button', className: 'rt-vtile', disabled: busy, 'data-mark': isMain(v) ? 'main' : isHidden(v) ? 'hidden' : undefined,
      'aria-label': `Open ${ordinal(v)} of ${a?.label || v.name}`, title: [v.name, markText(v), when(v.created_at)].filter(Boolean).join(' · '), onClick: () => openFromAll(v.id) },
      h(Thumb, { scope, version: v }),
      el('span', { className: 'rt-vtile-text' }, el('b', {}, ordinal(v)), mark(v), withAsset ? el('span', { className: 'rt-trunc' }, a?.label || '') : null)))
  }
  const allVersions = () => {
    const keep = v => (!hits || hits.has(v.id)) && (!mainOnly || isMain(v))
    const at = v => Date.parse(v.created_at) || 0
    const groups = versionsBy === 'asset' ? foundAssets.map(a => ({ a, items: a.items.filter(keep) })).filter(g => g.items.length) : []
    const newest = versionsBy === 'date' ? versions.map((v, i) => [v, i]).filter(([v]) => keep(v)).sort((x, y) => at(y[0]) - at(x[0]) || y[1] - x[1]).map(([v]) => v) : []
    const none = versionsBy === 'asset' ? !groups.length : !newest.length
    // The New asset tile (and new-asset runs) lead: first in the newest-first grid, or a row of their own above the asset groups.
    const lead = [newAssetCard(), ...newRunCards()]
    return el('section', { key: 'versions', className: 'rt-main rt-allv', 'aria-label': 'All versions', ...dropZone },
      el('header', { className: 'rt-bar' }, el('div', { className: 'rt-bar-title' }, el('h3', {}, 'All versions')),
        el('div', { className: 'rt-cmp-tools' },
          el('div', { className: 'rt-view', role: 'group', 'aria-label': 'Group versions' }, ...[['asset', 'By asset'], ['date', 'By date']].map(([k, label]) =>
            el('button', { key: k, type: 'button', 'aria-pressed': versionsBy === k, onClick: () => setVersionsBy(k) }, label))),
          el('div', { className: 'rt-view' }, el('button', { type: 'button', 'aria-pressed': mainOnly, onClick: () => setMainOnly(!mainOnly) }, icon(ICON.star, mainOnly), 'Main only')))),
      none ? el('div', { className: 'rt-allv-body' }, el('ul', { className: 'rt-vgrid' }, ...lead), emptyBox({ role: 'status', title: hits ? 'No match' : 'No Main yet' }))
        : el('div', { className: 'rt-allv-body' }, versionsBy === 'asset'
          ? [el('ul', { key: 'lead', className: 'rt-vgrid' }, ...lead), ...groups.map(g => el('div', { key: g.a.id, role: 'group', 'aria-label': g.a.label }, el('h4', {}, g.a.label), el('ul', { className: 'rt-vgrid' }, ...g.items.map(v => versionTile(v, false)))))]
          : el('ul', { className: 'rt-vgrid', 'aria-label': 'Newest first' }, ...lead, ...newest.map(v => versionTile(v, true)))))
  }
  const confirmDelete = () => {
    const sameProject = data && data.project.id === deleting.id
    const contents = sameProject ? [plural(assets.length, 'asset'), `${plural(versions.length, 'version')} and their media files`, data.annotations.length && plural(data.annotations.length, 'note'), data.briefs.length && plural(data.briefs.length, 'revision request'), attempts.length && plural(attempts.length, 'generation record')].filter(Boolean).join(', ') : 'all of its assets, versions, notes, revision requests and generation records'
    const blockedNow = sameProject && openAttempts > 0
    const close = () => { if (!busy) setDeleting(null) }
    return el('div', { key: 'delete', className: 'rt-overlay', onMouseDown: e => { if (e.target === e.currentTarget) close() }, onKeyDown: e => { if (e.key === 'Escape') close() } },
      el('div', { className: 'rt-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': `Delete project ${deleting.name}`, 'aria-describedby': 'retake-delete-body' },
        el('h2', {}, `Delete “${deleting.name}”?`),
        el('p', { id: 'retake-delete-body' }, `Permanently removes ${contents}. This can’t be undone.`),
        blockedNow ? el('p', { className: 'rt-dialog-error', role: 'status' }, 'A generation is in progress. Wait for it to finish before deleting.') : null,
        deleteError ? el('p', { className: 'rt-dialog-error', role: 'alert' }, deleteError) : null,
        el('div', { className: 'rt-row' },
          btn('Cancel', close, { disabled: busy, autoFocus: true }),
          btn(busy ? 'Deleting…' : 'Delete project', () => deleteProject(deleting), { variant: undefined, className: 'rt-danger', disabled: busy || blockedNow, 'aria-label': `Delete project ${deleting.name} permanently` }))))
  }
  let main
  if (missing) main = notHere()
  else if (!pid) main = projects.error ? emptyMain('pick', emptyBox({ kind: 'error', role: 'alert', title: 'Projects unavailable', body: text(projects.error) }))
    : list.length ? projectGrid()
      : emptyMain('pick', projects.data ? emptyBox({ title: 'No projects yet', actions: btn('Create project', startNewProject, { disabled: busy }) })
        : emptyBox({ kind: 'loading', role: 'status', body: 'Loading projects…' }))
  else if (detail.error) main = emptyMain('error', emptyBox({ kind: 'error', role: 'alert', title: 'Could not load project', body: text(detail.error), actions: btn('Retry', () => detail.refetch()) }))
  else if (!data) main = emptyMain('loading', emptyBox({ kind: 'loading', role: 'status', body: 'Loading project…' }))
  else if (!versions.length) main = guide()
  else if (mode === 'compare') main = comparison
  else if (mode === 'lineage' && selected && asset) main = lineageView()
  else if (showOverview) main = overview()
  else if (showVersions) main = allVersions()
  else if (selected) main = h(Review, { key: selected.id, scope, version: selected, versions, assetLabel: assetOf(selected)?.label || shortId(selected.asset_id), ordinalOf: ordinal, originOf, detail: data, act, busy, drafts, tab, setTab, fieldsOpen, setFieldsOpen, ...genProps, onExpand: openLightbox, onRemoveNote: removeNote, modeSwitch,
    pendingGen: genShown, onHideGen: () => genShown && setGenHidden(ids => [...ids, genShown.id]) })
  else main = emptyMain('choose', emptyBox({ role: 'status', title: 'Choose a version', body: 'Pick a tile in the filmstrip below.' }))
  // New-asset generation: a centred dialog over the page, opened from All assets or an empty project.
  const composerOn = composer && !!data && !!pid
  const composerDialog = composerOn ? h(NewAssetComposer, { key: 'composer', gen, route, prompt: genPrompt, setPrompt: setGenPrompt, aspect: genAspect, setAspect: setGenAspect, model: models.last, setModel: pickModel, recent: models.recent, picks,
    onGenerate: sendNew, onClose: closeComposer, busy, generating, blocked: genBlocked, attempts: attempts.filter(a => a.kind === 'new_asset'), onCheck: checkStatus, onSend: sendReserved, onCancel: cancelReserved }) : null

  // The A/B compare chip on each strip card (one compare state, two slots).
  const compareChip = v => {
    const chosen = compare.includes(v.id)
    return el('label', { className: 'rt-check', title: chosen ? `Compare slot ${'AB'[compare.indexOf(v.id)]}` : compare.length >= 2 ? 'Two versions already chosen; untick one first' : 'Choose for Compare' },
      el('input', { type: 'checkbox', checked: chosen, disabled: !chosen && compare.length >= 2, onChange: e => toggleCompare(v.id, e.target.checked), 'aria-label': `Compare ${v.name}` }),
      el('span', { 'aria-hidden': 'true' }, chosen ? el('b', {}, 'AB'[compare.indexOf(v.id)]) : 'Compare'))
  }
  // Card label: "v2" large with ★ Main or Hidden (nothing otherwise), then the source tags.
  const frameText = (v, o) => el('span', { className: 'rt-frame-text' },
    el('span', { className: 'rt-frame-head' }, el('span', { className: 'rt-frame-v' }, ordinal(v)), mark(v)),
    el('span', { className: 'rt-tags', title: o.title }, ...o.tags.map(t => el('span', { key: t.kind, className: 'rt-tag', 'data-kind': t.kind },
      t.kind === 'upload' ? icon(ICON.upload) : t.kind === 'model' ? icon(ICON.spark) : null, el('span', {}, t.text)))))
  // Review and Lineage: ancestors of the viewed version get an accent edge; other branches dim (never hidden).
  const lines = (mode === 'review' || mode === 'lineage') && selected && asset && selected.asset_id === asset.id ? lineMap(selected, asset.items) : null
  const frame = v => {
    const reviewing = (mode === 'review' || mode === 'lineage') && v.id === active && !genShown // the pending card is the one shown
    return el('li', { key: v.id, className: 'rt-frame', 'data-active': reviewing ? 'true' : undefined, 'data-line': lines ? lines.get(v.id) || 'other' : undefined, 'data-mark': isMain(v) ? 'main' : isHidden(v) ? 'hidden' : undefined },
      el('button', { type: 'button', className: 'rt-frame-btn', disabled: busy, 'aria-pressed': reviewing, 'aria-label': `Review ${v.name}`, title: [v.name, markText(v), lineage(v, versions)].filter(Boolean).join(' · '), onClick: () => openTile(v.id) },
        h(Thumb, { scope, version: v }),
        // Thumbnail, ordinal and status identify the take; the stored filename stays in the tooltip, details and download.
        frameText(v, originOf(v))),
      compareChip(v))
  }
  // A running attempt is shown as a placeholder tile, never as a version and never with a review status.
  // The card of the revision shown on the stage opens that view (parent, dimmed, with its progress).
  const pendingTile = a => el('li', { key: `attempt-${a.id}`, className: 'rt-frame', 'data-attempt': a.state, 'data-active': genShown?.id === a.id ? 'true' : undefined, title: `Generation attempt ${a.id}` },
    el(stageGen?.id === a.id ? 'button' : 'div', stageGen?.id === a.id
      ? { type: 'button', className: 'rt-frame-btn', 'aria-pressed': genShown?.id === a.id, 'aria-label': `Generating ${stageGen.to} from ${stageGen.from}`, onClick: showGen }
      : { className: 'rt-frame-btn' },
      el('span', { className: 'rt-thumb' }, a.state === 'reserved' ? 'Reserved…' : el('span', { className: 'rt-spin', 'aria-hidden': 'true' })),
      el('span', { className: 'rt-frame-text' },
        el('span', { className: 'rt-astate' }, a.state === 'reserved' ? 'Reserved' : 'Generating…'),
        el('span', { className: 'rt-frame-file' }, stageGen?.id === a.id ? `${stageGen.to} from ${stageGen.from}` : a.kind === 'revision' ? 'Next version' : 'New asset'))))
  // "N hidden": shows the folded hidden versions, or folds them again.
  const hiddenTile = list => {
    const folded = asset ? asset.items.length - list.length : 0
    if (!hiddenCount || (!showHidden && !folded)) return null
    return el('li', { key: 'hidden', className: 'rt-hidden-tile' }, el('button', { type: 'button', className: 'rt-hidden-btn', 'aria-expanded': showHidden, title: showHidden ? 'Fold hidden versions' : 'Show hidden versions', onClick: () => setShowHidden(!showHidden) },
      icon(ICON.eyeClosed), `${showHidden ? hiddenCount : folded} hidden`))
  }
  const pendingHere = runningAttempts.filter(a => a.kind === 'new_asset' || (asset && a.asset_id === asset.id))
  // Actions on the viewed version: its next version comes from a file here or from the Review inspector's request.
  const canRevise = selected && selected.mime !== 'video/mp4' && gen.available && gen.revision
  const versionActions = selected ? [
    el('label', { key: 'up', className: 'rt-upload', 'data-disabled': busy ? 'true' : undefined, title: `Adds a version after ${ordinal(selected)}. PNG/JPEG/WebP ≤12 MB${VIDEO_UPLOADS ? ' · MP4 ≤32 MB, ≤120 s' : ''}.` }, icon(ICON.upload), el('span', {}, busy ? 'Saving…' : 'Upload next version'),
      el('input', { type: 'file', accept: UPLOAD_ACCEPT, disabled: busy, 'aria-label': 'Upload next version', onChange: e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) act({ path: `/projects/${enc(pid)}/versions?parent_id=${enc(selected.id)}`, file: f, after: v => review(v.id) }) } })),
    canRevise ? btn([icon(ICON.spark), el('span', { key: 't' }, 'Generate next version')], focusRevision, { key: 'gen', className: 'rt-gen-next', disabled: busy, title: `Describe the change beside the image, then generate after ${ordinal(selected)}` }) : null] : []
  const showStrip = !!data && !offAsset && (!!asset || pendingHere.length > 0)
  const strip = showStrip && el('section', { key: 'strip', className: 'rt-strip', 'aria-label': 'Version filmstrip' },
    el('div', { className: 'rt-strip-main' },
      el('div', { className: 'rt-strip-head' },
        el('h3', { className: 'rt-strip-title' }, 'Versions', asset ? el('span', { className: 'rt-strip-count' }, asset.items.length) : null),
        assets.length > 1 ? el('span', { className: 'rt-muted' }, plural(assets.length, 'asset')) : null,
        // Compare is an action on two ticked versions, not a mode tab.
        compare.length === 1 ? el('span', { className: 'rt-muted' }, 'Tick one more to compare') : null,
        runningAttempts.length ? el('span', { className: 'rt-muted', role: 'status' }, `${runningAttempts[0].state === 'reserved' ? 'Reserved' : 'Generating'} · attempt ${shortId(runningAttempts[0].id)}`) : null,
        el('div', { className: 'rt-strip-actions' },
          pairHere && mode !== 'compare' ? btn(`Compare ${compare.map(id => ordinal(versions.find(v => v.id === id) || {}) || '?').join(' · ')}`, () => chooseMode('compare'), { variant: undefined, className: 'rt-compare-go', disabled: busy }) : null,
          ...versionActions)),
      el('ul', { className: 'rt-film' }, ...stripItems.map(frame), hiddenTile(stripItems), ...pendingHere.map(pendingTile))))

  const insp = mode === 'review' && selected && !offAsset ? 'open' : 'none'
  return el('main', { className: 'retake', 'aria-label': 'Retake creative review', 'data-tight': height > 0 && height < 480 ? 'true' : 'false', 'data-compact': height > 0 && (height < 1000 || dock === 'bottom') ? 'true' : 'false', ref: root }, h('style', { children: css }),
    header,
    el('div', { className: 'rt-shell', style: { '--rt-panel': `${panelOpen && !panelFloat ? PANEL_W : 0}px` } },
      rail, panel,
      el('div', { className: 'rt-work', id: 'retake-work', 'data-dock': dock, 'data-insp': insp, 'data-mode': mode }, main, strip,
      toasts.length ? el('div', { className: 'rt-toasts' }, el('div', { className: 'rt-toast-stack' }, ...toasts.map(t => t.quiet
        ? el('div', { key: t.id, className: 'rt-sr', role: 'status', 'aria-live': 'polite' }, t.text)
        : h(Toast, { key: t.id, toast: t, onClose: () => closeToast(t.id),
          // A new version that is not the one on screen gets a View button.
          action: t.undo ? { label: 'Undo', onClick: () => undoNote(t.undo) } : t.made?.version_id && versions.some(v => v.id === t.made.version_id) && !(mode === 'review' && active === t.made.version_id && !offAsset) ? { label: 'View', onClick: () => navigateReview(t.made.version_id) } : null },
          t.made ? madeText(t.made) : [t.head ? el('strong', { key: 'h' }, t.head) : t.kind === 'error' ? el('strong', { key: 'h' }, 'Not saved. ') : null, t.text])))) : null)),
    composerDialog,
    projectMenu(),
    newProjectForm,
    lightboxOn ? h(Lightbox, { key: 'lightbox', scope, items: stripItems, version: selected, ordinalOf: ordinal, onStep: stepLightbox, onClose: closeLightbox }) : null,
    deleting ? confirmDelete() : null)
}
function Root({ ctx }) {
  const profile = useValue(host.state.profile)
  const epoch = useGatewayActivationEpoch()
  // A connection can change without a new activation epoch (the primary re-homes), so it is part of the scope too.
  const connectionId = useValue(host.state.connectionId || NO_CONNECTION)
  return h(Workspace, { key: `${ctx.source}:${connectionId ?? ''}:${profile}:${epoch}`, ctx, profile, epoch, connectionId })
}
export default {
  id: 'retake', name: 'Retake', defaultEnabled: false,
  register(ctx) {
    ctx.register({ id: 'page', area: ROUTES_AREA, data: { path: '/retake' }, render: () => h(Root, { ctx }) })
    ctx.register({ id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: '/retake', label: 'Retake', codicon: 'versions' } })
    // Hermes command palette rows. No keybind: ⌘K is Hermes' own.
    ctx.register({ id: 'open-project', area: PALETTE_AREA, data: { id: 'retake.openProject', label: 'Retake: Open project…', keywords: ['retake', 'project', 'switch', 'open'], run: () => requestPage('switch') } })
    ctx.register({ id: 'new-project', area: PALETTE_AREA, data: { id: 'retake.newProject', label: 'Retake: New project', keywords: ['retake', 'project', 'new', 'create'], run: () => requestPage('new') } })
  }
}
