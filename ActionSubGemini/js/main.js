/**
 * main.js - ActionSubGemini CEP Extension Logic
 * Kiến trúc Tinh gọn 2 Bước AI (Streamlined Two-Pass AI Architecture):
 * - Bước 1: Nén trực tiếp các file video clip bằng FFmpeg (480x270, 10fps, No Audio)
 *           -> Tách phân đoạn 90s (gộp đuôi ngắn < 30s vào đoạn kế cuối, chuẩn yuv420p)
 *           -> Gửi song song lên gemini-3.8-flash quan sát trung thực hành động kèm mốc thời gian.
 * - Bước 2: Storyline Unifier (Khoá cứng 100% ID & Timestamp gốc qua JSON)
 *           -> Biên tập câu chữ mượt mà, thống nhất tên gọi dụng cụ và liên kết mạch lạc từ đầu đến cuối
 *           -> Xuất file .SRT mới (kèm timestamp chống cache) & chèn thẳng lên Timeline.
 */

(function () {
    'use strict';

    // 1. Kiểm tra môi trường Node.js trong CEP
    const isNodeAvailable = typeof require !== 'undefined';
    if (!isNodeAvailable) {
        console.error("Node.js is not enabled in CEP! Check manifest.xml flags --enable-nodejs and --mixed-context.");
    }

    const fs = isNodeAvailable ? require('fs') : null;
    const path = isNodeAvailable ? require('path') : null;
    const https = isNodeAvailable ? require('https') : null;
    const http = isNodeAvailable ? require('http') : null;
    const child_process = isNodeAvailable ? require('child_process') : null;
    const os = isNodeAvailable ? require('os') : null;
    const urlModule = isNodeAvailable ? require('url') : null;

    // Khởi tạo Adobe CSInterface
    const csInterface = new CSInterface();

    // Default System Prompt: Quan sát trung thực hành động thực tế trên khung hình
    const DEFAULT_SYSTEM_PROMPT =
`You are an accurate Visual Action Recognition AI and instructional video subtitler.
Watch the video closely and generate a clear, faithful SubRip (.srt) subtitle file describing the physical actions, tool operations, and practical steps taking place on screen.

Guidelines:
1. Observe and describe every real action, tool usage, measurement, assembly, or test step accurately at the exact timestamp it happens on screen.
2. Keep descriptions natural, clear, and easy to follow.
3. Maintain chronological order and continuous numbering starting from 1.
4. Output RAW .srt format ONLY. Do NOT include markdown code fences (no \`\`\`srt or \`\`\`), no intro text, and no commentary outside the .srt entries.`;

    // System Prompt cho Khán giả Nam 65+ tại Mỹ (DIY & Tool Sharpening)
    const US_SENIOR_DIY_SYSTEM_PROMPT =
`ROLE & TARGET AUDIENCE:
You are an experienced, friendly American master craftsman writing instructional subtitles for Men aged 65+ in the United States who enjoy sharpening tools, restoring hardware, and practical workshop DIY projects.

GUIDELINES:
1. Watch the physical actions, hand movements, and tool operations in the video closely and describe each step clearly at its exact timestamp.
2. Use natural, authentic American workshop terminology (e.g., workbench, vice, bevel, burr, grit, grinding wheel, cutting edge, angle grinder, jig, guide, pass, deburr, snug it down, true it up).
3. Keep each subtitle concise, clear, and easy for seniors to read (8 to 14 words per subtitle entry).
4. Output ONLY valid SubRip (.srt) format synchronized accurately with the actions in the video. No markdown blocks and no extra commentary.`;

    // DOM Elements - General & Model
    const apiKeyInput = document.getElementById('apiKey');
    const toggleApiKeyBtn = document.getElementById('toggleApiKey');
    const getApiKeyLink = document.getElementById('getApiKeyLink');
    const modelNameInput = document.getElementById('modelName');
    const modelSuggestions = document.getElementById('modelSuggestions');
    const btnFetchModels = document.getElementById('btnFetchModels');
    const fetchSpinner = document.getElementById('fetchSpinner');
    const modelCountBadge = document.getElementById('modelCountBadge');
    const headerBadge = document.getElementById('headerBadge');
    const targetLanguageSelect = document.getElementById('targetLanguage');
    const customLanguageInput = document.getElementById('customLanguageInput');
    const personaModeSelect = document.getElementById('personaMode');
    const personaBadge = document.getElementById('personaBadge');
    const personaGroup = document.querySelector('.persona-group');
    const storyContextInput = document.getElementById('storyContext');
    const systemPromptInput = document.getElementById('systemPrompt');
    const resetPromptBtn = document.getElementById('resetPromptBtn');
    const enableFfmpegCheckbox = document.getElementById('enableFfmpeg');

    // DOM Elements - Subtitle Style & Timeline
    const autoInsertTimeline = document.getElementById('autoInsertTimeline');
    const insertModeContainer = document.getElementById('insertModeContainer');
    const insertMode = document.getElementById('insertMode');
    const subFont = document.getElementById('subFont');
    const subSize = document.getElementById('subSize');
    const subColor = document.getElementById('subColor');
    const subColorHex = document.getElementById('subColorHex');
    const subStrokeColor = document.getElementById('subStrokeColor');
    const subStrokeColorHex = document.getElementById('subStrokeColorHex');
    const subStrokeWidth = document.getElementById('subStrokeWidth');
    const subPosY = document.getElementById('subPosY');
    const maxCharsPerLine = document.getElementById('maxCharsPerLine');

    // DOM Elements - Action & Log
    const btnProcess = document.getElementById('btnProcess');
    const btnSpinner = document.getElementById('btnSpinner');
    const btnText = document.getElementById('btnText');
    const progressBarContainer = document.getElementById('progressBarContainer');
    const progressBarInner = document.getElementById('progressBarInner');
    const statusLog = document.getElementById('statusLog');
    const btnClearLog = document.getElementById('btnClearLog');
    const engineStatus = document.getElementById('engineStatus');

    // State
    let isProcessing = false;

    // ==========================================
    // INITIALIZATION & SETTINGS STORAGE
    // ==========================================
    function initSettings() {
        try {
            const savedKey = localStorage.getItem('actionsub_gemini_api_key') || '';
            if (savedKey) apiKeyInput.value = savedKey;

            let savedModel = localStorage.getItem('actionsub_gemini_model') || 'gemini-3.8-flash';
            if (!savedModel || !savedModel.includes('3.8') || savedModel.toLowerCase().includes('preview')) {
                savedModel = 'gemini-3.8-flash';
                localStorage.setItem('actionsub_gemini_model', 'gemini-3.8-flash');
            }

            if (modelNameInput) modelNameInput.value = savedModel;
            if (headerBadge) headerBadge.textContent = savedModel;

            const savedLang = localStorage.getItem('actionsub_gemini_lang') || 'Tiếng Việt';
            const langExists = Array.from(targetLanguageSelect.options).some(o => o.value === savedLang);
            if (langExists) {
                targetLanguageSelect.value = savedLang;
                customLanguageInput.style.display = 'none';
            } else {
                targetLanguageSelect.value = 'custom';
                customLanguageInput.value = savedLang;
                customLanguageInput.style.display = 'block';
            }

            const savedPersona = localStorage.getItem('actionsub_persona_mode') || 'standard';
            if (personaModeSelect) {
                personaModeSelect.value = (savedPersona === 'us_senior_diy') ? 'us_senior_diy' : 'standard';
            }
            updatePersonaUI(personaModeSelect ? personaModeSelect.value : 'standard');

            const savedStoryContext = localStorage.getItem('actionsub_story_context');
            if (savedStoryContext !== null && storyContextInput) {
                storyContextInput.value = savedStoryContext;
            }

            const savedPrompt = localStorage.getItem('actionsub_gemini_prompt');
            const isLegacyPrompt = savedPrompt && (
                savedPrompt.includes('Smart Milestone Density') ||
                savedPrompt.includes('High-Retention') ||
                savedPrompt.includes('ANTI-REPETITION')
            );
            if (savedPrompt !== null && savedPrompt.trim().length > 0 && !isLegacyPrompt) {
                systemPromptInput.value = savedPrompt;
            } else {
                systemPromptInput.value = (savedPersona === 'us_senior_diy') ? US_SENIOR_DIY_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT;
                localStorage.setItem('actionsub_gemini_prompt', systemPromptInput.value);
            }

            const savedFfmpeg = localStorage.getItem('actionsub_gemini_ffmpeg');
            if (savedFfmpeg !== null) {
                enableFfmpegCheckbox.checked = savedFfmpeg === 'true';
            }

            const savedAutoInsert = localStorage.getItem('actionsub_auto_insert');
            if (savedAutoInsert !== null && autoInsertTimeline) {
                autoInsertTimeline.checked = savedAutoInsert === 'true';
            }

            const savedInsertMode = localStorage.getItem('actionsub_insert_mode');
            if (savedInsertMode && insertMode) insertMode.value = savedInsertMode;

            const savedFont = localStorage.getItem('actionsub_sub_font');
            if (savedFont && subFont) subFont.value = savedFont;

            const savedSize = localStorage.getItem('actionsub_sub_size');
            if (savedSize && subSize) subSize.value = savedSize;

            const savedColor = localStorage.getItem('actionsub_sub_color');
            if (savedColor && subColor) {
                subColor.value = savedColor;
                if (subColorHex) subColorHex.textContent = savedColor.toUpperCase();
            }

            const savedStrokeColor = localStorage.getItem('actionsub_sub_stroke_color');
            if (savedStrokeColor && subStrokeColor) {
                subStrokeColor.value = savedStrokeColor;
                if (subStrokeColorHex) subStrokeColorHex.textContent = savedStrokeColor.toUpperCase();
            }

            const savedStrokeWidth = localStorage.getItem('actionsub_sub_stroke_width');
            if (savedStrokeWidth && subStrokeWidth) subStrokeWidth.value = savedStrokeWidth;

            const savedPosY = localStorage.getItem('actionsub_sub_pos_y');
            if (savedPosY && subPosY) subPosY.value = savedPosY;

            const savedMaxChars = localStorage.getItem('actionsub_max_chars');
            if (savedMaxChars && maxCharsPerLine) maxCharsPerLine.value = savedMaxChars;

            updateStyleControlsVisibility();

            if (isNodeAvailable) {
                engineStatus.textContent = `Node ${process.version}`;
                engineStatus.style.color = '#8ec07c';
            } else {
                engineStatus.textContent = "Node.js N/A";
                engineStatus.style.color = '#e06c75';
                addLog("Cảnh báo: CEP chưa bật Node.js. Vui lòng kiểm tra manifest.xml!", "error");
            }
        } catch (e) {
            console.error("Init settings error:", e);
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem('actionsub_gemini_api_key', apiKeyInput.value.trim());
            if (modelNameInput) {
                const currentModel = modelNameInput.value.trim() || 'gemini-3.8-flash';
                localStorage.setItem('actionsub_gemini_model', currentModel);
                if (headerBadge) headerBadge.textContent = currentModel;
            }
            const lang = targetLanguageSelect.value === 'custom' ? customLanguageInput.value.trim() : targetLanguageSelect.value;
            localStorage.setItem('actionsub_gemini_lang', lang);
            if (personaModeSelect) localStorage.setItem('actionsub_persona_mode', personaModeSelect.value);
            if (storyContextInput) localStorage.setItem('actionsub_story_context', storyContextInput.value.trim());
            localStorage.setItem('actionsub_gemini_prompt', systemPromptInput.value);
            localStorage.setItem('actionsub_gemini_ffmpeg', String(enableFfmpegCheckbox.checked));

            if (autoInsertTimeline) localStorage.setItem('actionsub_auto_insert', String(autoInsertTimeline.checked));
            if (insertMode) localStorage.setItem('actionsub_insert_mode', insertMode.value);
            if (subFont) localStorage.setItem('actionsub_sub_font', subFont.value.trim());
            if (subSize) localStorage.setItem('actionsub_sub_size', subSize.value);
            if (subColor) localStorage.setItem('actionsub_sub_color', subColor.value);
            if (subStrokeColor) localStorage.setItem('actionsub_sub_stroke_color', subStrokeColor.value);
            if (subStrokeWidth) localStorage.setItem('actionsub_sub_stroke_width', subStrokeWidth.value);
            if (subPosY) localStorage.setItem('actionsub_sub_pos_y', subPosY.value);
            if (maxCharsPerLine) localStorage.setItem('actionsub_max_chars', maxCharsPerLine.value);
        } catch (e) {
            console.error("Save settings error:", e);
        }
    }

    function updatePersonaUI(mode) {
        if (!personaBadge) return;
        if (mode === 'us_senior_diy') {
            personaBadge.textContent = 'US 65+ DIY';
            personaBadge.classList.add('us-diy');
            if (personaGroup) personaGroup.classList.add('active-us-diy');
        } else {
            personaBadge.textContent = 'Standard';
            personaBadge.classList.remove('us-diy');
            if (personaGroup) personaGroup.classList.remove('active-us-diy');
        }
    }

    function updateStyleControlsVisibility() {
        const isAuto = autoInsertTimeline ? autoInsertTimeline.checked : true;
        if (insertModeContainer) insertModeContainer.style.opacity = isAuto ? '1' : '0.4';
    }

    // ==========================================
    // LOGGING & UI HELPERS
    // ==========================================
    function addLog(message, type = 'info') {
        const timeStr = new Date().toLocaleTimeString();
        const line = document.createElement('div');
        line.className = `log-line ${type}`;
        line.textContent = `[${timeStr}] ${message}`;
        statusLog.appendChild(line);
        statusLog.scrollTop = statusLog.scrollHeight;
    }

    function clearLog() {
        statusLog.innerHTML = '';
    }

    function setProgress(percent, isIndeterminate = false) {
        progressBarContainer.style.display = 'block';
        if (isIndeterminate) {
            progressBarInner.classList.add('indeterminate');
        } else {
            progressBarInner.classList.remove('indeterminate');
            progressBarInner.style.width = `${Math.min(100, Math.max(0, percent))}%`;
        }
    }

    function hideProgress() {
        progressBarContainer.style.display = 'none';
        progressBarInner.classList.remove('indeterminate');
        progressBarInner.style.width = '0%';
    }

    function setProcessingState(active, buttonText = "⚡ Phân Tích Hành Vi & Tạo SRT") {
        isProcessing = active;
        btnProcess.disabled = active;
        btnSpinner.style.display = active ? 'inline-block' : 'none';
        btnText.textContent = buttonText;
        if (!active) hideProgress();
    }

    function formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function formatSecondsToMMSS(seconds) {
        if (!seconds || isNaN(seconds) || seconds <= 0) return "00:00";
        const totalSecs = Math.round(seconds);
        const mins = Math.floor(totalSecs / 60);
        const secs = totalSecs % 60;
        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    function hexToRgb(hex) {
        const clean = (hex || '#FFFFFF').replace('#', '');
        return {
            r: parseInt(clean.substring(0, 2), 16) || 255,
            g: parseInt(clean.substring(2, 4), 16) || 255,
            b: parseInt(clean.substring(4, 6), 16) || 255
        };
    }

    function escapeXml(unsafe) {
        return (unsafe || '').replace(/[<>&'"]/g, (c) => {
            switch (c) {
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '&': return '&amp;';
                case '\'': return '&apos;';
                case '"': return '&quot;';
            }
        });
    }

    const sleep = ms => new Promise(res => setTimeout(res, ms));

    // ==========================================
    // EVENT LISTENERS
    // ==========================================
    toggleApiKeyBtn.addEventListener('click', () => {
        if (apiKeyInput.type === 'password') {
            apiKeyInput.type = 'text';
            toggleApiKeyBtn.textContent = '🔒';
        } else {
            apiKeyInput.type = 'password';
            toggleApiKeyBtn.textContent = '👁️';
        }
    });

    apiKeyInput.addEventListener('change', saveSettings);

    if (modelNameInput) {
        modelNameInput.addEventListener('input', saveSettings);
        modelNameInput.addEventListener('change', () => {
            saveSettings();
            addLog(`Đã đặt mô hình AI: ${modelNameInput.value.trim()}`, "info");
        });
    }

    if (btnFetchModels) {
        btnFetchModels.addEventListener('click', fetchAvailableModels);
    }

    getApiKeyLink.addEventListener('click', () => {
        csInterface.openURLInDefaultBrowser("https://aistudio.google.com/app/apikey");
    });

    targetLanguageSelect.addEventListener('change', () => {
        if (targetLanguageSelect.value === 'custom') {
            customLanguageInput.style.display = 'block';
            customLanguageInput.focus();
        } else {
            customLanguageInput.style.display = 'none';
        }
        saveSettings();
    });

    customLanguageInput.addEventListener('change', saveSettings);

    if (personaModeSelect) {
        personaModeSelect.addEventListener('change', () => {
            const mode = personaModeSelect.value;
            updatePersonaUI(mode);
            if (mode === 'us_senior_diy') {
                systemPromptInput.value = US_SENIOR_DIY_SYSTEM_PROMPT;
                saveSettings();
                addLog("🛠️ Đã chọn phong cách Khán giả Nam 65+ Hoa Kỳ (DIY & Tool Sharpening).", "info");
            } else {
                systemPromptInput.value = DEFAULT_SYSTEM_PROMPT;
                saveSettings();
                addLog("Đã chọn phong cách mô tả hành động tiêu chuẩn (Standard Action Recognition).", "info");
            }
        });
    }

    if (storyContextInput) {
        storyContextInput.addEventListener('change', saveSettings);
        storyContextInput.addEventListener('input', saveSettings);
    }

    systemPromptInput.addEventListener('change', saveSettings);
    enableFfmpegCheckbox.addEventListener('change', saveSettings);

    if (autoInsertTimeline) {
        autoInsertTimeline.addEventListener('change', () => {
            saveSettings();
            updateStyleControlsVisibility();
        });
    }

    if (insertMode) insertMode.addEventListener('change', saveSettings);
    if (subFont) subFont.addEventListener('change', saveSettings);
    if (subSize) subSize.addEventListener('change', saveSettings);

    if (subColor) {
        subColor.addEventListener('input', () => {
            if (subColorHex) subColorHex.textContent = subColor.value.toUpperCase();
        });
        subColor.addEventListener('change', saveSettings);
    }

    if (subStrokeColor) {
        subStrokeColor.addEventListener('input', () => {
            if (subStrokeColorHex) subStrokeColorHex.textContent = subStrokeColor.value.toUpperCase();
        });
        subStrokeColor.addEventListener('change', saveSettings);
    }

    if (subStrokeWidth) subStrokeWidth.addEventListener('change', saveSettings);
    if (subPosY) subPosY.addEventListener('change', saveSettings);
    if (maxCharsPerLine) maxCharsPerLine.addEventListener('change', saveSettings);

    resetPromptBtn.addEventListener('click', () => {
        if (personaModeSelect) personaModeSelect.value = 'standard';
        updatePersonaUI('standard');
        systemPromptInput.value = DEFAULT_SYSTEM_PROMPT;
        saveSettings();
        addLog("Đã khôi phục chế độ Tiêu chuẩn và System Prompt mặc định.", "info");
    });

    btnClearLog.addEventListener('click', clearLog);

    btnProcess.addEventListener('click', () => {
        if (!isProcessing) {
            startWorkflow();
        }
    });

    // ==========================================
    // EXTENDSCRIPT COMMUNICATION PROMISE
    // ==========================================
    function callExtendScript(script) {
        return new Promise((resolve, reject) => {
            csInterface.evalScript(script, (result) => {
                if (result === 'EvalScript error.' || result === undefined) {
                    reject(new Error("Lỗi thực thi ExtendScript trong Premiere Pro."));
                    return;
                }
                try {
                    const parsed = JSON.parse(result);
                    resolve(parsed);
                } catch (e) {
                    resolve({ raw: result });
                }
            });
        });
    }

    // ==========================================
    // FFMPEG & FFPROBE HELPERS
    // ==========================================
    let cachedNvencSupport = null;

    function checkFfmpegAvailable() {
        return new Promise((resolve) => {
            if (!child_process) return resolve(false);
            child_process.exec('ffmpeg -version', (err) => {
                resolve(!err);
            });
        });
    }

    function checkNvencSupport() {
        if (cachedNvencSupport !== null) return Promise.resolve(cachedNvencSupport);
        if (!child_process) return Promise.resolve(false);
        return new Promise((resolve) => {
            child_process.exec('ffmpeg -f lavfi -i testsrc=duration=1:size=480x270:rate=10 -c:v h264_nvenc -f null -', (err) => {
                cachedNvencSupport = !err;
                resolve(cachedNvencSupport);
            });
        });
    }

    function getEncoderParams(useNvenc) {
        if (useNvenc) {
            return ['-c:v', 'h264_nvenc', '-preset', 'p1', '-cq', '28'];
        } else {
            return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-threads', '0'];
        }
    }

    function runFfmpegCommand(args) {
        return new Promise((resolve, reject) => {
            const proc = child_process.spawn('ffmpeg', args);
            let stderrData = '';
            proc.stderr.on('data', (d) => {
                stderrData += d.toString();
            });
            proc.on('error', (err) => reject(err));
            proc.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Lệnh FFmpeg thất bại (code ${code}): ${stderrData.slice(-300)}`));
                }
            });
        });
    }

    async function runFfmpegWithEncoder(buildArgsFn) {
        const hasNvenc = await checkNvencSupport();
        if (hasNvenc) {
            try {
                const nvencArgs = buildArgsFn(true);
                await runFfmpegCommand(nvencArgs);
                return;
            } catch (err) {
                console.warn("NVENC encoder failed, falling back to libx264:", err.message);
            }
        }
        const cpuArgs = buildArgsFn(false);
        await runFfmpegCommand(cpuArgs);
    }

    /**
     * Đo thời lượng thực tế chính xác đến từng mili-giây (actualDurationSec) của file video bằng ffprobe / ffmpeg -i
     */
    function getActualVideoDurationSec(filePath) {
        return new Promise((resolve) => {
            if (!child_process || !filePath || !fs.existsSync(filePath)) {
                return resolve(0);
            }
            child_process.execFile('ffprobe', [
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                filePath
            ], (err, stdout) => {
                if (!err && stdout) {
                    const parsed = parseFloat(String(stdout).trim());
                    if (!isNaN(parsed) && parsed > 0) {
                        return resolve(parsed);
                    }
                }
                child_process.execFile('ffmpeg', ['-i', filePath], (_err2, _stdout2, stderr2) => {
                    const text = String(stderr2 || '');
                    const m = text.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/i);
                    if (m) {
                        const h = parseInt(m[1], 10);
                        const min = parseInt(m[2], 10);
                        const s = parseFloat(m[3]);
                        const totalSec = h * 3600 + min * 60 + s;
                        if (!isNaN(totalSec) && totalSec > 0) {
                            return resolve(totalSec);
                        }
                    }
                    resolve(0);
                });
            });
        });
    }

    /**
     * Thư mục làm việc tạm thời riêng biệt để tránh bị Windows Temp Cleaner / Storage Sense tự động xoá file .mp4 khi đang chờ AI xử lý
     */
    function getSafeWorkDir() {
        try {
            const baseDir = (os && typeof os.homedir === 'function') ? os.homedir() : os.tmpdir();
            const workDir = path.join(baseDir, '.actionsub_gemini_work');
            if (!fs.existsSync(workDir)) {
                fs.mkdirSync(workDir, { recursive: true });
            }
            return workDir;
        } catch (e) {
            return os.tmpdir();
        }
    }

    /**
     * Nén trực tiếp 1 clip bằng FFmpeg (480x270, 10fps, yuv420p, No Audio) kèm cơ chế đảm bảo file > 1KB cho clip ngắn
     */
    async function encodeSingleClipGuaranteed(clip, partPath, clipIndex, uniqueSuffix, tempFilesTracker) {
        const tempDir = getSafeWorkDir();
        const srcIn = (clip.srcIn !== undefined) ? Number(clip.srcIn) : (Number(clip.inPoint) || 0);
        const srcOut = (clip.srcOut !== undefined) ? Number(clip.srcOut) : (Number(clip.outPoint) || 0);
        const seqStart = (clip.seqStart !== undefined) ? Number(clip.seqStart) : (Number(clip.start) || 0);
        const seqEnd = (clip.seqEnd !== undefined) ? Number(clip.seqEnd) : (Number(clip.end) || 0);

        const sourceDuration = (srcOut > srcIn) ? (srcOut - srcIn) : (Number(clip.duration) || 1.0);
        const timelineDuration = (seqEnd > seqStart) ? (seqEnd - seqStart) : (Number(clip.duration) || sourceDuration || 1.0);
        const clipDuration = Math.max(0.2, timelineDuration);

        const ptsExpr = (sourceDuration > 0.05 && Math.abs(timelineDuration - sourceDuration) > 0.05)
            ? `setpts=${(timelineDuration / sourceDuration).toFixed(4)}*(PTS-STARTPTS)`
            : 'setpts=PTS-STARTPTS';

        const vfFilter = `${ptsExpr},scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2,fps=10`;

        const buildArgs = (useLegacyVsync = false) => {
            const args = ['-y'];
            if (srcIn > 0) args.push('-ss', String(srcIn));
            if (srcOut > srcIn) args.push('-to', String(srcOut));
            args.push(
                '-i', clip.mediaPath,
                '-t', clipDuration.toFixed(4),
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-crf', '28',
                '-vf', vfFilter,
                '-pix_fmt', 'yuv420p',
                '-video_track_timescale', '10000'
            );
            if (useLegacyVsync) {
                args.push('-vsync', 'cfr');
            } else {
                args.push('-fps_mode', 'cfr');
            }
            args.push('-an', '-movflags', '+faststart', partPath);
            return args;
        };

        try {
            try {
                await runFfmpegCommand(buildArgs(false));
            } catch (errPrimary) {
                await runFfmpegCommand(buildArgs(true));
            }
        } catch (e) {
            // Chuyển sang fallback lặp 1 frame bên dưới nếu clip cực ngắn
        }

        if (!fs.existsSync(partPath) || fs.statSync(partPath).size < 1024) {
            const tempFramePath = path.join(tempDir, `temp_frame_${clipIndex}_${uniqueSuffix}.jpg`);
            tempFilesTracker.push(tempFramePath);

            try {
                const extractArgs = ['-y'];
                if (srcIn > 0) extractArgs.push('-ss', String(srcIn));
                extractArgs.push(
                    '-i', clip.mediaPath,
                    '-frames:v', '1',
                    '-update', '1',
                    '-vf', 'scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2',
                    tempFramePath
                );
                await runFfmpegCommand(extractArgs);
            } catch (e1) {}

            if (fs.existsSync(tempFramePath) && fs.statSync(tempFramePath).size >= 100) {
                try {
                    await runFfmpegCommand([
                        '-y',
                        '-loop', '1',
                        '-i', tempFramePath,
                        '-t', clipDuration.toFixed(4),
                        '-c:v', 'libx264',
                        '-preset', 'ultrafast',
                        '-crf', '28',
                        '-vf', 'setpts=PTS-STARTPTS,scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2,fps=10',
                        '-pix_fmt', 'yuv420p',
                        '-video_track_timescale', '10000',
                        '-an',
                        '-movflags', '+faststart',
                        partPath
                    ]);
                } catch (eLoop) {}
                try { if (fs.existsSync(tempFramePath)) fs.unlinkSync(tempFramePath); } catch (eDel) {}
            }

            if (!fs.existsSync(partPath) || fs.statSync(partPath).size < 1024) {
                await runFfmpegCommand([
                    '-y',
                    '-f', 'lavfi',
                    '-i', 'color=c=black:s=480x270:r=10',
                    '-t', clipDuration.toFixed(4),
                    '-c:v', 'libx264',
                    '-preset', 'ultrafast',
                    '-crf', '28',
                    '-pix_fmt', 'yuv420p',
                    '-video_track_timescale', '10000',
                    '-an',
                    '-movflags', '+faststart',
                    partPath
                ]);
            }
        }
    }

    // ==========================================
    // BƯỚC 1A: NÉN TRỰC TIẾP CÁC FILE VIDEO CLIP BẰNG FFMPEG (KHÔNG XUẤT FILE TỪ PREMIERE)
    // ==========================================
    async function prepareMasterVideoForAI(clips, useFfmpeg, tempFilesTracker, clipInfo = null) {
        const hasFfmpeg = await checkFfmpegAvailable();
        const tempDir = getSafeWorkDir();
        const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        // TRƯỜNG HỢP 1: Nhiều clip trên Timeline -> Nén trực tiếp từng file video và ghép nối bằng FFmpeg
        if (clips.length > 1) {
            if (!hasFfmpeg) {
                addLog("Cảnh báo: Phát hiện nhiều clip trên Timeline nhưng máy chưa cài FFmpeg. Buộc gửi clip đầu tiên.", "warning");
                return clips[0].mediaPath;
            }

            addLog(`Đang nén trực tiếp ${clips.length} clip video (480x270, 10fps, yuv420p, No Audio) bằng FFmpeg...`, "info");
            setProgress(10);

            const partFiles = [];
            const firstSeqStart = (clips[0].seqStart !== undefined) ? Number(clips[0].seqStart) : (Number(clips[0].start) || 0);
            let timelineCursor = firstSeqStart;

            for (let i = 0; i < clips.length; i++) {
                const clip = clips[i];
                const clipSeqStart = (clip.seqStart !== undefined) ? Number(clip.seqStart) : ((clip.start !== undefined) ? Number(clip.start) : timelineCursor);
                const clipSeqEnd = (clip.seqEnd !== undefined) ? Number(clip.seqEnd) : ((clip.end !== undefined) ? Number(clip.end) : (clipSeqStart + (Number(clip.duration) || 0)));

                // Bù khoảng trống (Gap > 0.1s) giữa 2 clip trên Timeline nếu có
                if (i > 0 && clipSeqStart > timelineCursor + 0.1) {
                    const gapSec = clipSeqStart - timelineCursor;
                    const gapPath = path.join(tempDir, `actionsub_gap_${i}_${uniqueSuffix}.mp4`);
                    tempFilesTracker.push(gapPath);
                    await runFfmpegCommand([
                        '-y',
                        '-f', 'lavfi',
                        '-i', 'color=c=black:s=480x270:r=10',
                        '-t', gapSec.toFixed(4),
                        '-c:v', 'libx264',
                        '-preset', 'ultrafast',
                        '-crf', '28',
                        '-pix_fmt', 'yuv420p',
                        '-video_track_timescale', '10000',
                        '-an',
                        '-movflags', '+faststart',
                        gapPath
                    ]);
                    if (fs.existsSync(gapPath) && fs.statSync(gapPath).size >= 512) {
                        partFiles.push(gapPath);
                    }
                    timelineCursor = clipSeqStart;
                }

                const partPath = path.join(tempDir, `actionsub_part_${i}_${uniqueSuffix}.mp4`);
                tempFilesTracker.push(partPath);

                await encodeSingleClipGuaranteed(clip, partPath, i, uniqueSuffix, tempFilesTracker);
                partFiles.push(partPath);

                const clipTimelineDur = (clipSeqEnd > clipSeqStart) ? (clipSeqEnd - clipSeqStart) : (Number(clip.duration) || 0);
                if (clipSeqEnd > timelineCursor) {
                    timelineCursor = clipSeqEnd;
                } else {
                    timelineCursor += clipTimelineDur;
                }

                const clipPct = Math.floor(10 + ((i + 1) / clips.length) * 10);
                setProgress(clipPct);
                addLog(`Đã nén [${i + 1}/${clips.length}] clip...`, "dim");
            }

            const listFilePath = path.join(tempDir, `concat_list_${uniqueSuffix}.txt`);
            tempFilesTracker.push(listFilePath);
            const listContent = partFiles.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n');
            fs.writeFileSync(listFilePath, listContent, 'utf8');

            const finalConcatPath = path.join(tempDir, `final_merged_video_${uniqueSuffix}.mp4`);
            tempFilesTracker.push(finalConcatPath);

            await runFfmpegCommand([
                '-f', 'concat',
                '-safe', '0',
                '-i', listFilePath,
                '-c', 'copy',
                '-y',
                finalConcatPath
            ]);

            for (const part of partFiles) {
                try { if (fs.existsSync(part)) fs.unlinkSync(part); } catch (e) {}
            }
            try { if (fs.existsSync(listFilePath)) fs.unlinkSync(listFilePath); } catch (e) {}

            if (!fs.existsSync(finalConcatPath) || fs.statSync(finalConcatPath).size < 1024) {
                throw new Error("File ghép nối tổng thể không hợp lệ hoặc dưới 1KB.");
            }

            const finalSize = fs.statSync(finalConcatPath).size;
            const measuredMasterDur = await getActualVideoDurationSec(finalConcatPath);
            if (clipInfo && measuredMasterDur > 0) {
                clipInfo.verifiedMasterDurationSec = measuredMasterDur;
            }
            addLog(`✓ Đã nén & ghép nối trực tiếp [${clips.length}/${clips.length}] clip (${formatBytes(finalSize)}, thời lượng: ${measuredMasterDur.toFixed(2)}s)!`, "success");
            return finalConcatPath;
        }

        // TRƯỜNG HỢP 2: Chỉ có 1 clip duy nhất -> Nén trực tiếp file video bằng FFmpeg
        const singleClip = clips[0];
        if (!useFfmpeg || !hasFfmpeg) {
            return singleClip.mediaPath;
        }

        addLog("Đang nén trực tiếp file video (480x270, 10fps, yuv420p, No Audio) bằng FFmpeg...", "info");
        setProgress(15, true);

        const tempOutputPath = path.join(tempDir, `master_video_${uniqueSuffix}.mp4`);
        tempFilesTracker.push(tempOutputPath);

        await encodeSingleClipGuaranteed(singleClip, tempOutputPath, 0, uniqueSuffix, tempFilesTracker);

        if (fs.existsSync(tempOutputPath) && fs.statSync(tempOutputPath).size >= 1024) {
            const measuredDur = await getActualVideoDurationSec(tempOutputPath);
            if (clipInfo && measuredDur > 0) {
                clipInfo.verifiedMasterDurationSec = measuredDur;
            }
            addLog(`✓ Đã nén trực tiếp video thành công (${formatBytes(fs.statSync(tempOutputPath).size)})!`, "success");
            return tempOutputPath;
        }

        return singleClip.mediaPath;
    }

    // ==========================================
    // BƯỚC 1B: CẮT PHÂN ĐOẠN 90 GIÂY (GỘP ĐUÔI NGẮN < 30S VÀO ĐOẠN KẾ CUỐI)
    // ==========================================
    async function extractSingleChunkVideo(masterVideoPath, startSec, durationSec, chunkPath) {
        await runFfmpegWithEncoder((useNvenc) => {
            const args = [
                '-y',
                '-ss', Number(startSec || 0).toFixed(3),
                '-t', Number(durationSec || 90).toFixed(3),
                '-i', masterVideoPath,
                '-vf', 'setpts=PTS-STARTPTS,scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2,fps=10'
            ];
            args.push(...getEncoderParams(useNvenc));
            args.push('-pix_fmt', 'yuv420p', '-g', '20', '-an', '-movflags', '+faststart', chunkPath);
            return args;
        });
    }

    async function segmentVideoIntoChunks(masterVideoPath, totalDuration, chunkDuration = 90, tempFilesTracker) {
        const tempDir = getSafeWorkDir();
        const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        const measuredMasterDur = await getActualVideoDurationSec(masterVideoPath);
        const masterDurationSec = (measuredMasterDur && measuredMasterDur > 0) ? measuredMasterDur : totalDuration;

        // Tính toán các khung cắt 90s; nếu phần đuôi còn lại < 30s thì gộp luôn vào đoạn kế cuối để tránh lỗi file rỗng < 1KB
        const plannedWindows = [];
        let cursorSec = 0;
        let idx = 0;

        while (cursorSec < masterDurationSec - 0.1) {
            const remaining = masterDurationSec - cursorSec;
            if (remaining < chunkDuration + 30) {
                plannedWindows.push({
                    chunkIndex: idx,
                    planStartSec: cursorSec,
                    planDurationSec: remaining
                });
                cursorSec = masterDurationSec;
            } else {
                plannedWindows.push({
                    chunkIndex: idx,
                    planStartSec: cursorSec,
                    planDurationSec: chunkDuration
                });
                cursorSec += chunkDuration;
            }
            idx++;
        }

        addLog(`Đang tách video (${formatSecondsToMMSS(masterDurationSec)}) thành ${plannedWindows.length} phân đoạn chuẩn yuv420p (gộp đuôi < 30s)...`, "info");
        setProgress(20, true);

        const rawChunkFiles = [];

        for (let i = 0; i < plannedWindows.length; i++) {
            const win = plannedWindows[i];
            const chunkPath = path.join(tempDir, `actionsub_chunk_${String(i).padStart(3, '0')}_${uniqueSuffix}.mp4`);
            tempFilesTracker.push(chunkPath);

            await extractSingleChunkVideo(masterVideoPath, win.planStartSec, win.planDurationSec, chunkPath);

            if (fs.existsSync(chunkPath) && fs.statSync(chunkPath).size >= 1024) {
                rawChunkFiles.push({
                    chunkIndex: i,
                    chunkPath: chunkPath,
                    planStartSec: win.planStartSec,
                    planDurationSec: win.planDurationSec
                });
            } else {
                throw new Error(`Phân đoạn chunk ${i + 1}/${plannedWindows.length} tạo ra không hợp lệ hoặc dưới 1KB.`);
            }
        }

        // Đo thời lượng thực tế của từng chunk bằng ffprobe để tính offset cộng dồn chuẩn xác
        const actualDurationSec = [];
        const chunkOffsets = [];
        const chunkItems = [];

        for (let i = 0; i < rawChunkFiles.length; i++) {
            const item = rawChunkFiles[i];
            let measuredDur = await getActualVideoDurationSec(item.chunkPath);
            if (!measuredDur || measuredDur <= 0) {
                measuredDur = item.planDurationSec;
            }
            actualDurationSec[i] = measuredDur;
            chunkOffsets[i] = (i === 0) ? 0 : (chunkOffsets[i - 1] + actualDurationSec[i - 1]);

            chunkItems.push({
                chunkIndex: i,
                chunkPath: item.chunkPath,
                planStartSec: item.planStartSec,
                planDurationSec: item.planDurationSec,
                startSec: chunkOffsets[i],
                durationSec: actualDurationSec[i],
                actualDurationSec: actualDurationSec[i],
                offsetSec: chunkOffsets[i]
            });

            addLog(`📏 Phân đoạn ${i + 1}/${rawChunkFiles.length}: Dài ${actualDurationSec[i].toFixed(2)}s (${formatSecondsToMMSS(chunkOffsets[i])} ➔ ${formatSecondsToMMSS(chunkOffsets[i] + actualDurationSec[i])})`, "dim");
        }

        return chunkItems;
    }

    /**
     * Nén lại định dạng dự phòng (480x270, 10fps, yuv420p) nếu Google File API báo lỗi giải mã (Code 13) hoặc file chunk bị thiếu
     */
    async function reencodeFallbackVideo(sourcePath, startSec, durationSec, tempFilesTracker) {
        const tempDir = getSafeWorkDir();
        const fallbackPath = path.join(tempDir, `fallback_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.mp4`);
        tempFilesTracker.push(fallbackPath);

        const args = ['-y'];
        if (startSec !== undefined && startSec > 0) args.push('-ss', String(startSec));
        if (durationSec !== undefined && durationSec > 0) args.push('-t', String(durationSec));
        args.push(
            '-i', sourcePath,
            '-vf', 'setpts=PTS-STARTPTS,scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2,fps=10',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '26',
            '-pix_fmt', 'yuv420p',
            '-g', '20',
            '-an',
            '-movflags', '+faststart',
            fallbackPath
        );

        await runFfmpegCommand(args);

        if (!fs.existsSync(fallbackPath) || fs.statSync(fallbackPath).size < 1024) {
            throw new Error("File nén dự phòng không hợp lệ hoặc dưới 1KB.");
        }

        return fallbackPath;
    }

    // ==========================================
    // HTTP UTILS (NODE.JS NATIVE HTTPS)
    // ==========================================
    function makeHttpRequest(urlStr, options = {}, postData = null) {
        return new Promise((resolve, reject) => {
            const parsedUrl = urlModule.parse(urlStr);
            const isHttps = parsedUrl.protocol === 'https:';
            const client = isHttps ? https : http;

            const reqOptions = {
                protocol: parsedUrl.protocol,
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (isHttps ? 443 : 80),
                path: parsedUrl.path,
                method: options.method || 'GET',
                headers: options.headers || {}
            };

            const req = client.request(reqOptions, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: body
                    });
                });
            });

            req.on('error', (err) => reject(err));

            if (postData) {
                if (Buffer.isBuffer(postData) || typeof postData === 'string') {
                    req.write(postData);
                    req.end();
                } else if (typeof postData.pipe === 'function') {
                    postData.pipe(req);
                } else {
                    req.write(postData);
                    req.end();
                }
            } else {
                req.end();
            }
        });
    }

    // ==========================================
    // AUTO-FETCH AVAILABLE MODELS VIA GOOGLE API
    // ==========================================
    async function fetchAvailableModels() {
        const apiKey = apiKeyInput.value.trim();
        if (!apiKey) {
            addLog("Vui lòng nhập Google Gemini API Key trước khi lấy danh sách model!", "warning");
            apiKeyInput.focus();
            return [];
        }

        if (btnFetchModels) btnFetchModels.disabled = true;
        if (fetchSpinner) fetchSpinner.style.display = 'inline-block';
        addLog("Đang truy vấn danh sách model ổn định từ Google AI API...", "info");

        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
            const res = await makeHttpRequest(url, { method: 'GET' });

            if (res.statusCode < 200 || res.statusCode >= 300) {
                throw new Error(`Google API trả về mã lỗi HTTP ${res.statusCode}: ${res.body}`);
            }

            const data = JSON.parse(res.body);
            if (!data.models || !Array.isArray(data.models)) {
                throw new Error("Dữ liệu model trả về không hợp lệ.");
            }

            const isUsableContentModel = (m) => {
                if (!m || !m.name || !Array.isArray(m.supportedGenerationMethods)) return false;
                if (!m.supportedGenerationMethods.includes('generateContent')) return false;
                const lower = m.name.toLowerCase();
                if (lower.includes('embedding') || lower.includes('aqa') || lower.includes('imagen') ||
                    lower.includes('tts') || lower.includes('image') || lower.includes('audio') ||
                    lower.includes('Auto') || lower.includes('robotics') || lower.includes('computer-use') ||
                    lower.includes('gemma') || lower.includes('learnlm')) {
                    return false;
                }
                return lower.includes('gemini');
            };

            const contentModels = data.models.filter(isUsableContentModel);

            if (contentModels.length === 0) {
                addLog("Đang dùng danh sách model mặc định: gemini-3.8-flash, gemini-3.8-pro.", "info");
                return ['gemini-3.8-flash', 'gemini-3.8-pro'];
            }

            if (modelSuggestions) {
                modelSuggestions.innerHTML = '';
                contentModels.forEach(m => {
                    const cleanName = m.name.replace(/^models\//, '');
                    const opt = document.createElement('option');
                    opt.value = cleanName;
                    opt.textContent = `${cleanName} (${m.displayName || ''})`;
                    modelSuggestions.appendChild(opt);
                });
            }

            if (modelCountBadge) {
                modelCountBadge.textContent = `(${contentModels.length} models)`;
            }

            const cleanNames = contentModels.map(m => m.name.replace(/^models\//, ''));
            addLog(`Đã tải thành công ${contentModels.length} model từ Google!`, "success");

            const currentVal = modelNameInput ? modelNameInput.value.trim() : '';
            if (!currentVal || !cleanNames.includes(currentVal)) {
                const autoPick = cleanNames.find(n => n.includes('3.8-flash')) ||
                                 cleanNames.find(n => n.includes('3.') && n.includes('flash')) ||
                                 cleanNames.find(n => n.includes('flash')) ||
                                 cleanNames[0] ||
                                 'gemini-3.8-flash';
                if (modelNameInput) {
                    modelNameInput.value = autoPick;
                    saveSettings();
                    addLog(`Tự động chọn model chính: ${autoPick}`, "info");
                }
            }

            return cleanNames;
        } catch (err) {
            console.error("Fetch models error:", err);
            addLog(`Lỗi tải danh sách model: ${err.message}`, "error");
            return ['gemini-3.8-flash', 'gemini-3.8-pro'];
        } finally {
            if (btnFetchModels) btnFetchModels.disabled = false;
            if (fetchSpinner) fetchSpinner.style.display = 'none';
        }
    }

    function resolvePrimaryModel(preferredModel) {
        const clean = (preferredModel || 'gemini-3.8-flash').replace(/^models\//, '').trim();
        return clean || 'gemini-3.8-flash';
    }

    /**
     * Lấy danh sách các model ứng viên (Model Fallback Pool) để tự động chuyển đổi
     * sang model khác BẤT KỂ LÝ DO GÌ khiến model hiện tại không hoạt động.
     */
    async function getModelCandidates(apiKey, preferredModel) {
        const primary = resolvePrimaryModel(preferredModel);
        const candidates = [];
        const addUnique = (name) => {
            if (!name) return;
            const clean = name.replace(/^models\//, '').trim();
            if (clean && !candidates.includes(clean)) {
                candidates.push(clean);
            }
        };

        // 1. Ưu tiên model người dùng đang chọn đầu tiên
        addUnique(primary);
        addUnique('gemini-3.8-flash');
        addUnique('gemini-3.8-pro');

        // 2. Truy vấn danh sách model thực tế khả dụng trên API Key từ Google Server
        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
            const res = await makeHttpRequest(url, { method: 'GET' });
            if (res.statusCode >= 200 && res.statusCode < 300) {
                const data = JSON.parse(res.body);
                if (data && Array.isArray(data.models)) {
                    const usable = data.models
                        .filter(m => {
                            if (!m || !m.name || !Array.isArray(m.supportedGenerationMethods)) return false;
                            if (!m.supportedGenerationMethods.includes('generateContent')) return false;
                            const lower = m.name.toLowerCase();
                            if (lower.includes('embedding') || lower.includes('aqa') || lower.includes('imagen') ||
                                lower.includes('tts') || lower.includes('image') || lower.includes('audio') ||
                                lower.includes('robotics') || lower.includes('computer-use') ||
                                lower.includes('gemma') || lower.includes('learnlm')) {
                                return false;
                            }
                            return lower.includes('gemini');
                        })
                        .map(m => m.name.replace(/^models\//, '').trim());

                    // Sắp xếp ưu tiên: dòng 3.8 -> dòng 3.x -> flash -> pro
                    const tierScore = (name) => {
                        const n = name.toLowerCase();
                        let score = 0;
                        if (n.includes('3.8')) score += 100;
                        else if (n.includes('gemini-3')) score += 80;
                        if (!n.includes('preview') && !n.includes('exp')) score += 20;
                        if (n.includes('flash') && !n.includes('lite')) score += 10;
                        else if (n.includes('pro')) score += 8;
                        return score;
                    };

                    usable.sort((a, b) => tierScore(b) - tierScore(a));
                    usable.forEach(addUnique);
                }
            }
        } catch (e) {
            // Bỏ qua lỗi mạng khi lấy danh sách model phụ, dùng danh sách dự phòng bên dưới
        }

        // 3. Đảm bảo luôn có nhiều model dự phòng trong danh sách nếu truy vấn danh sách trống
        [
            'gemini-3.8-flash',
            'gemini-3.8-pro',
            'gemini-3.1-flash',
            'gemini-3.1-pro',
            'gemini-3.0-flash',
            'gemini-3.0-pro'
        ].forEach(addUnique);

        return candidates;
    }

    /**
     * Đưa model vừa chạy thành công lên đầu danh sách để các phân đoạn sau dùng ngay
     */
    function promoteWorkingModel(modelCandidates, workingModel) {
        if (!Array.isArray(modelCandidates) || !workingModel) return;
        const idx = modelCandidates.indexOf(workingModel);
        if (idx > 0) {
            modelCandidates.splice(idx, 1);
            modelCandidates.unshift(workingModel);
        }
    }

    /**
     * Đẩy model vừa bị lỗi xuống cuối danh sách để các phân đoạn khác không gọi lại ngay
     */
    function demoteFailedModel(modelCandidates, failedModel) {
        if (!Array.isArray(modelCandidates) || modelCandidates.length <= 1 || !failedModel) return;
        const idx = modelCandidates.indexOf(failedModel);
        if (idx !== -1 && idx < modelCandidates.length - 1) {
            modelCandidates.splice(idx, 1);
            modelCandidates.push(failedModel);
        }
    }

    // ==========================================
    // GOOGLE GEMINI RESUMABLE FILE UPLOAD & POLLING
    // ==========================================
    async function uploadVideoToGemini(filePath, apiKey) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File không tồn tại trên ổ đĩa: ${filePath}`);
        }
        const stats = fs.statSync(filePath);
        if (stats.size < 1024) {
            throw new Error(`File video quá nhỏ hoặc rỗng (${stats.size} bytes). Không thể upload lên Google Server.`);
        }
        const fileSize = stats.size;
        const fileName = path.basename(filePath);

        const initUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
        const metadata = JSON.stringify({
            file: { display_name: fileName }
        });

        const initRes = await makeHttpRequest(initUrl, {
            method: 'POST',
            headers: {
                'X-Goog-Upload-Protocol': 'resumable',
                'X-Goog-Upload-Command': 'start',
                'X-Goog-Upload-Header-Content-Length': String(fileSize),
                'X-Goog-Upload-Header-Content-Type': 'video/mp4',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(metadata)
            }
        }, metadata);

        if (initRes.statusCode < 200 || initRes.statusCode >= 300) {
            throw new Error(`Khởi tạo upload thất bại (HTTP ${initRes.statusCode}): ${initRes.body}`);
        }

        const uploadUrl = initRes.headers['x-goog-upload-url'];
        if (!uploadUrl) {
            throw new Error("Không nhận được header 'x-goog-upload-url' từ Google File API.");
        }

        const uploadRes = await new Promise((resolve, reject) => {
            const parsedUploadUrl = urlModule.parse(uploadUrl);
            const req = https.request({
                protocol: parsedUploadUrl.protocol,
                hostname: parsedUploadUrl.hostname,
                port: parsedUploadUrl.port || 443,
                path: parsedUploadUrl.path,
                method: 'POST',
                headers: {
                    'Content-Length': String(fileSize),
                    'X-Goog-Upload-Offset': '0',
                    'X-Goog-Upload-Command': 'upload, finalize'
                }
            }, (res) => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    resolve({
                        statusCode: res.statusCode,
                        body: Buffer.concat(chunks).toString('utf8')
                    });
                });
            });

            req.on('error', err => reject(err));

            const fileStream = fs.createReadStream(filePath);
            fileStream.pipe(req);
        });

        if (uploadRes.statusCode < 200 || uploadRes.statusCode >= 300) {
            throw new Error(`Upload dữ liệu video thất bại (HTTP ${uploadRes.statusCode}): ${uploadRes.body}`);
        }

        const uploadData = JSON.parse(uploadRes.body);
        if (!uploadData.file || !uploadData.file.name) {
            throw new Error(`Response upload không đúng định dạng: ${uploadRes.body}`);
        }

        return uploadData.file;
    }

    async function waitForFileActive(fileResource, apiKey) {
        const fileResourceName = fileResource.name;
        const checkUrl = `https://generativelanguage.googleapis.com/v1beta/${fileResourceName}?key=${apiKey}`;
        const startTime = Date.now();
        const maxWaitMs = 10 * 60 * 1000;

        while (true) {
            if (Date.now() - startTime > maxWaitMs) {
                throw new Error("Quá thời gian chờ (Timeout) xử lý video trên Google Server.");
            }

            const res = await makeHttpRequest(checkUrl, { method: 'GET' });
            if (res.statusCode < 200 || res.statusCode >= 300) {
                throw new Error(`Lỗi kiểm tra trạng thái file (HTTP ${res.statusCode}): ${res.body}`);
            }

            const fileStatus = JSON.parse(res.body);
            const state = fileStatus.state;

            if (state === "ACTIVE") {
                return fileStatus;
            } else if (state === "FAILED") {
                const errCode = fileStatus.error?.code || 0;
                const errMsg = fileStatus.error?.message || JSON.stringify(fileStatus.error || "File failed");
                const err = new Error(`Gemini Server xử lý video thất bại (Code ${errCode}): ${errMsg}`);
                err.code = errCode;
                throw err;
            } else {
                await sleep(3000);
            }
        }
    }

    async function uploadAndActivateVideo(videoPath, apiKey, fallbackOptions, tempFilesTracker) {
        let currentPath = videoPath;
        let attempt = 0;
        const maxAttempts = 3;

        while (attempt < maxAttempts) {
            attempt++;
            let uploadedFile = null;
            try {
                if (!fs.existsSync(currentPath) || fs.statSync(currentPath).size < 1024) {
                    if (fallbackOptions && fallbackOptions.sourcePath && fs.existsSync(fallbackOptions.sourcePath)) {
                        addLog("⚠️ File phân đoạn tạm không tồn tại trên ổ đĩa, đang tự động trích xuất lại từ video gốc...", "warning");
                        currentPath = await reencodeFallbackVideo(fallbackOptions.sourcePath, fallbackOptions.startSec, fallbackOptions.durationSec, tempFilesTracker);
                    }
                }
                uploadedFile = await uploadVideoToGemini(currentPath, apiKey);
                const activeFile = await waitForFileActive(uploadedFile, apiKey);
                return { activeFile, uploadedFile };
            } catch (err) {
                if (uploadedFile && uploadedFile.name) {
                    deleteGeminiFile(uploadedFile.name, apiKey);
                }

                const errMsg = (err && err.message) ? err.message : String(err);
                const isCode13 = err.code === 13 || errMsg.includes('Code 13');
                const isMissingFile = errMsg.includes('ENOENT') || errMsg.includes('không tồn tại trên ổ đĩa') || !fs.existsSync(currentPath);

                if ((isCode13 || isMissingFile) && attempt < maxAttempts && fallbackOptions && fallbackOptions.sourcePath && fs.existsSync(fallbackOptions.sourcePath)) {
                    addLog(`⚠️ File phân đoạn gặp sự cố (${isCode13 ? 'Code 13' : 'Thiếu file tạm'}). Đang nén lại dự phòng và upload lại (Lần ${attempt + 1}/${maxAttempts})...`, "warning");
                    currentPath = await reencodeFallbackVideo(fallbackOptions.sourcePath, fallbackOptions.startSec, fallbackOptions.durationSec, tempFilesTracker);
                } else if (attempt < maxAttempts) {
                    await sleep(2000);
                } else {
                    throw err;
                }
            }
        }
    }

    // ==========================================
    // BƯỚC 1C: GỬI PHÂN ĐOẠN LÊN GEMINI QUAN SÁT TRUNG THỰC HÀNH ĐỘNG
    // ==========================================
    async function generateChunkContent(fileUri, apiKey, systemInstruction, language, modelName, durationSec, chunkIdx = 0, totalChunks = 1, storyContext = '') {
        const cleanModel = resolvePrimaryModel(modelName);
        const generateUrl = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${apiKey}`;
        const formattedDuration = formatSecondsToMMSS(durationSec);
        const currentPersona = personaModeSelect ? personaModeSelect.value : 'standard';

        const contextInfo = (storyContext && storyContext.trim().length > 0)
            ? `\nChủ đề của video: ${storyContext.trim()}.`
            : '';

        const chunkPositionInfo = `\nĐây là Phân đoạn ${chunkIdx + 1}/${totalChunks} của video (thời lượng phân đoạn này: 00:00 đến ${formattedDuration}, tương ứng ${durationSec.toFixed(2)} giây).${contextInfo}
Hãy quan sát trung thực toàn bộ các hành động, thao tác tay và dụng cụ diễn ra trên khung hình từ giây 00:00 đến ${formattedDuration} và tạo phụ đề .srt chuẩn xác với mốc thời gian của từng hành động (tất cả timestamps phải nằm trong khoảng 00:00:00,000 đến ${formattedDuration}).`;

        let effectiveSystemInstruction = systemInstruction;
        if (currentPersona === 'us_senior_diy' && !effectiveSystemInstruction.includes('ROLE & TARGET AUDIENCE:')) {
            effectiveSystemInstruction = `${US_SENIOR_DIY_SYSTEM_PROMPT}\n\n${effectiveSystemInstruction}`;
        }

        const targetLangDisplay = (currentPersona === 'us_senior_diy' && language.toLowerCase() === 'english')
            ? 'American English (US Workshop & Craftsman style)'
            : language;

        const userPromptText =
`Watch all physical actions, tool operations, and practical steps in this ${Math.round(durationSec)}-second video clip (00:00 to ${formattedDuration}) and generate an accurate SubRip (.srt) subtitle file in ${targetLangDisplay}.${chunkPositionInfo}
Output ONLY the raw .srt content without any markdown code blocks.`;

        const requestBody = JSON.stringify({
            system_instruction: {
                parts: [
                    { text: effectiveSystemInstruction + chunkPositionInfo }
                ]
            },
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            file_data: {
                                mime_type: "video/mp4",
                                file_uri: fileUri
                            }
                        },
                        {
                            text: userPromptText
                        }
                    ]
                }
            ],
            generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 8192
            }
        });

        const res = await makeHttpRequest(generateUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody)
            }
        }, requestBody);

        if (res.statusCode === 503 || res.statusCode === 429) {
            throw new Error(`HTTP ${res.statusCode}: Model ${cleanModel} đang quá tải (${res.body})`);
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
            throw new Error(`Gọi Gemini API thất bại (HTTP ${res.statusCode}): ${res.body}`);
        }

        const data = JSON.parse(res.body);
        if (!data.candidates || data.candidates.length === 0) {
            throw new Error("Gemini không trả về kết quả phụ đề nào.");
        }

        const candidate = data.candidates[0];
        if (candidate.finishReason === "SAFETY") {
            throw new Error("Nội dung video bị bộ lọc an toàn của Google từ chối.");
        }

        const rawText = extractCandidateText(candidate);
        if (!rawText || rawText.trim().length === 0) {
            throw new Error("Không nhận được nội dung text phụ đề từ Gemini.");
        }

        return sanitizeSrtContent(rawText);
    }

    function extractCandidateText(candidate) {
        const parts = candidate?.content?.parts;
        if (!Array.isArray(parts) || parts.length === 0) return '';
        const nonThoughtParts = parts.filter(p => !p.thought && typeof p.text === 'string' && p.text.trim().length > 0);
        if (nonThoughtParts.length > 0) {
            return nonThoughtParts.map(p => p.text).join('\n');
        }
        return parts.map(p => p.text || '').join('\n');
    }

    /**
     * Gọi Gemini cho từng phân đoạn: Tự động chuyển sang các model khác trong danh sách
     * BẤT KỂ LÝ DO GÌ khiến model hiện tại không hoạt động (404, 400, 403, 429, 500, 503, rỗng, lỗi mạng...)
     */
    async function generateChunkWithRetry(fileUri, apiKey, systemInstruction, language, modelCandidatesInput, durationSec, chunkIdx, totalChunks, storyContext = '') {
        const candidates = Array.isArray(modelCandidatesInput) && modelCandidatesInput.length > 0
            ? modelCandidatesInput
            : [resolvePrimaryModel(modelCandidatesInput)];

        const maxAttempts = Math.max(4, candidates.length);
        const triedModelsInThisChunk = new Set();
        let lastError = null;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            // Chọn model đầu tiên trong danh sách chưa bị lỗi ở phân đoạn này (nếu đã thử hết thì xoay vòng)
            let currentModel = candidates.find(m => !triedModelsInThisChunk.has(m));
            if (!currentModel) {
                currentModel = candidates[attempt % candidates.length];
            }
            triedModelsInThisChunk.add(currentModel);

            try {
                addLog(`[Phân đoạn ${chunkIdx + 1}/${totalChunks}] Đang phân tích hành động với model "${currentModel}" (Lần ${attempt + 1}/${maxAttempts})...`, "info");
                const resultSrt = await generateChunkContent(
                    fileUri, apiKey, systemInstruction, language, currentModel, durationSec, chunkIdx, totalChunks, storyContext
                );
                // Đưa model hoạt động tốt lên đầu danh sách để các phân đoạn khác dùng ngay
                promoteWorkingModel(candidates, currentModel);
                return resultSrt;
            } catch (err) {
                lastError = err;
                const errMsg = (err && err.message) ? err.message : String(err);

                // Đẩy model vừa gặp sự cố xuống cuối danh sách
                demoteFailedModel(candidates, currentModel);

                if (attempt < maxAttempts - 1) {
                    const nextModel = candidates.find(m => !triedModelsInThisChunk.has(m)) || candidates[(attempt + 1) % candidates.length];
                    const waitSec = 2;
                    addLog(`⚠️ [Phân đoạn ${chunkIdx + 1}/${totalChunks}] Model "${currentModel}" không hoạt động (${errMsg.substring(0, 140)}). Tự động chuyển sang model "${nextModel}" sau ${waitSec}s...`, "warning");
                    await sleep(waitSec * 1000);
                }
            }
        }

        throw lastError || new Error(`Phân đoạn ${chunkIdx + 1} thất bại sau khi thử ${maxAttempts} model.`);
    }

    // ==========================================
    // BƯỚC 2: BIÊN TẬP MẠCH TRUYỆN LIỀN MẠCH - KHOÁ CỨNG TIMESTAMP (STORYLINE UNIFIER)
    // ==========================================
    function parseSrtBlocksStrict(srtText) {
        const blocks = (srtText || '').trim().split(/\r?\n\r?\n/);
        const parsed = [];
        for (const block of blocks) {
            const lines = block.trim().split(/\r?\n/);
            if (lines.length >= 2) {
                let tcLineIdx = -1;
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes('-->')) {
                        tcLineIdx = i;
                        break;
                    }
                }
                if (tcLineIdx !== -1) {
                    const timecode = lines[tcLineIdx].trim();
                    const text = lines.slice(tcLineIdx + 1).join('\r\n').trim();
                    if (text.length > 0) {
                        parsed.push({
                            index: parsed.length + 1,
                            timecode: timecode,
                            text: text
                        });
                    }
                }
            }
        }
        return parsed;
    }

    /**
     * BƯỚC 2 (Storyline Unifier):
     * - Chuyển danh sách các câu phụ đề Bước 1 thành mảng JSON có đánh số ID cố định:
     *   [{ "id": 1, "time": "00:00:02,000 --> 00:00:05,500", "text": "..." }, ...]
     * - Gửi phần "text" qua 1 lần gọi text-only để biên tập lại câu chữ mượt mà,
     *   tự nhiên, thống nhất tên gọi dụng cụ và liên kết mạch lạc từ đầu đến cuối video.
     * - Tự động chuyển sang model khác bất kể lý do gì khiến model hiện tại không hoạt động.
     * - Ghép phần "text" đã biên tập vào đúng "time" gốc theo từng "id" (tuyệt đối không xoá câu, không lệch 1ms).
     */
    async function unifyAndRefineStoryline(rawSrt, personaMode, storyContext, language, apiKey, modelCandidatesInput = ['gemini-3.8-flash']) {
        if (!rawSrt || !rawSrt.trim()) {
            throw new Error("Dữ liệu phụ đề từ Bước 1 rỗng, không thể biên tập ở Bước 2.");
        }

        const originalCues = parseSrtBlocksStrict(rawSrt);
        if (originalCues.length === 0) {
            throw new Error("Không tìm thấy câu phụ đề hợp lệ nào từ Bước 1 để biên tập.");
        }

        // Chuyển thành mảng JSON có đánh số ID và mốc thời gian gốc cố định
        const sourceItems = originalCues.map((cue, idx) => ({
            id: idx + 1,
            time: cue.timecode,
            text: cue.text.replace(/\r?\n/g, ' ').trim()
        }));

        // Chỉ gửi { id, text } lên AI để biên tập phần câu chữ
        const payloadForAI = sourceItems.map(item => ({
            id: item.id,
            text: item.text
        }));

        const candidates = Array.isArray(modelCandidatesInput) && modelCandidatesInput.length > 0
            ? modelCandidatesInput
            : [resolvePrimaryModel(modelCandidatesInput)];

        addLog(`🔗 BƯỚC 2 (Storyline Unifier): Đang biên tập nối mạch truyện cho ${sourceItems.length} câu phụ đề (Khoá cứng 100% Timestamp gốc)...`, "step");

        const totalItems = sourceItems.length;
        const introEndId = Math.max(1, Math.round(totalItems * 0.2));
        const bodyStartId = Math.min(totalItems, introEndId + 1);
        const bodyEndId = Math.max(bodyStartId, Math.round(totalItems * 0.8));
        const outroStartId = Math.min(totalItems, bodyEndId + 1);

        const topicNote = (storyContext && storyContext.trim().length > 0)
            ? `Chủ đề / Cốt truyện chính của video: "${storyContext.trim()}".`
            : `Chủ đề chính của video: Tự suy luận dựa trên trình tự các bước thao tác từ đầu đến cuối danh sách để dẫn dắt thành một câu chuyện chế tạo/sửa chữa hấp dẫn.`;

        const isEnglishTarget = language.toLowerCase().includes('english') || language.toLowerCase().includes('tiếng anh') || language.toLowerCase() === 'en';
        const targetLangNote = isEnglishTarget
            ? 'American English (Authentic US Senior Craftsman & Garage Workshop style)'
            : `${language} (Biên dịch/Việt hóa tự nhiên theo đúng giọng điệu người thợ già Mỹ hóm hỉnh, từng trải đang trò chuyện tâm tình trong xưởng)`;

        const step2SystemInstruction =
`You are Step 2: Master Storyline Unifier & US Senior Craftsman Narrator.
Your job is to transform a raw chronological list of workshop actions from Step 1 into ONE cohesive, captivating, curiosity-driven story for Men aged 65+ in the United States who love repairing, sharpening tools, restoring old hardware, and working in their garage/workshop.
Before rewriting individual cues, internally map out the major Phases of the video so every single step serves ONE unified overarching goal planted in cue #1. At the first cue of every new Phase, you MUST write an explicit Phase-to-Phase Narrative Bridge explaining how the newly started part connects to the part just completed.
You MUST follow the 70% Curiosity-Driven Storytelling (Open Loops) + 30% Light & Savvy Instructional Touch formula, while keeping 100% of the original JSON item count and "id" numbers intact.`;

        const unifierPrompt =
`Bạn nhận được một mảng JSON gồm ${totalItems} câu phụ đề thô từ Bước 1 (đánh số "id" cố định từ 1 đến ${totalItems}) ghi nhận các hành động theo đúng trình tự thời gian từ đầu đến cuối video.
${topicNote}
Ngôn ngữ đầu ra bắt buộc cho trường "text": ${targetLangNote}.

===================================================================
1. CHÂN DUNG KHÁN GIẢ & VAI TRÒ NGƯỜI KỂ CHUYỆN (TARGET AUDIENCE & PERSONA)
===================================================================
- Đối tượng người xem: Nam giới trên 65 tuổi sống tại Hoa Kỳ, yêu thích sửa chữa, mài dũa dụng cụ, phục chế đồ cũ và làm việc trong xưởng (garage/workshop).
- Giọng văn (Tone of Voice): Giống như một người bạn già lành nghề, hóm hỉnh, từng trải đang vừa làm vừa trò chuyện tâm tình trong xưởng.
- Từ vựng đặc trưng: Thường xuyên sử dụng từ vựng đời thường, chuẩn chất thợ Mỹ (folks, fellas, old timer's trick, shop, workbench, scrap bin, bevel, burr, steady hand, sweet spot, good as new, slice like butter...) — hoặc từ ngữ tương đương đậm chất thợ lành nghề nếu xuất ra ngôn ngữ khác.

===================================================================
2. CÔNG THỨC NỘI DUNG: 70% DẪN DẮT GÂY TÒ MÒ + 30% HƯỚNG DẪN NHẸ NHÀNG
===================================================================
TUYỆT ĐỐI KHÔNG viết theo kiểu liệt kê từng thao tác khô khan như sách hướng dẫn sử dụng. Hãy biến các câu mô tả hành động thô từ Bước 1 thành một câu chuyện liền mạch:

- Gieo sự tò mò liên tục (Open Loops / Curiosity Gap - 70%):
  + Luôn khiến người xem tự hỏi điều gì sẽ xảy ra tiếp theo. Khi bắt đầu lấy một vật dụng hay cắt/mài một chi tiết, đừng nói toạc ra ngay kết quả, hãy dẫn dắt kiểu gợi mở:
    * "Most folks would toss this old piece right in the trash, but watch what happens next..."
    * "Now here is where it gets interesting—this little piece is the real secret to the whole setup..."
    * "Hold on, don't worry about that rough edge yet, you'll see why we need it in just a minute..."
    * "Wait till we put this edge to the test at the end—it’ll slice through like butter..."

- Pha trộn một ít hướng dẫn đắt giá (Light & Savvy Instructional Touch - 30%):
  + Chỉ lồng ghép hướng dẫn như những "bí quyết nhà nghề" nhẹ nhàng ngay lúc thao tác quan trọng diễn ra:
    * "Just keep a light touch right here so you don't overheat the steel..."
    * "Snug it down just enough so it holds that sweet spot angle..."

- Dẫn dắt mạch truyện tới tận giây cuối cùng (Full Narrative Arc):
  + Đoạn đầu - 0% đến 20% (Từ id 1 đến id ${introEndId}): Mở đầu gần gũi, khơi gợi vấn đề quen thuộc trong xưởng, xác lập MỘT mục tiêu xuyên suốt và hứa hẹn một mẹo/kết quả bất ngờ ở cuối video.
  + Đoạn giữa - 20% đến 80% (Từ id ${bodyStartId} đến id ${bodyEndId}): Kết nối các bước làm như một hành trình khám phá dần dần từng mảnh ghép. Dùng các từ nối tự nhiên ("Now for the fun part...", "Once that's sitting right...", "Here comes the magic trick...") để kéo khán giả đi từ bước này sang bước khác mà không muốn rời mắt.
  + Đoạn cuối - 80% đến 100% (Từ id ${outroStartId} đến id ${totalItems}): Đẩy sự hào hứng lên cao trào khi kiểm tra độ sắc bén/thành quả thực tế và kết lại bằng niềm tự hào của người thợ.

===================================================================
3. BẮT BUỘC TẠO CẦU NỐI CHUYỂN CẢNH (PHASE-TO-PHASE BRIDGING / EXPLICIT NARRATIVE BRIDGES)
===================================================================
- Trước khi viết lại từng câu, bạn PHẢI tự phân tích và xác định các Giai đoạn lớn (Phases) của toàn bộ video (Ví dụ: Phase 1: Nêu vấn đề cần giải quyết -> Phase 2: Chế tạo giá kẹp/ê-tô -> Phase 3: Làm tay cầm/dụng cụ phụ trợ -> Phase 4: Mài sắc & Thử nghiệm thực tế).
- Tại câu ĐẦU TIÊN của mỗi giai đoạn mới (khi video chuyển cảnh từ bộ phận/công đoạn này sang bộ phận/công đoạn khác, ví dụ chuyển từ làm ê-tô sang gọt cành cây làm cán dũa, hoặc chuyển từ xưởng ra ngoài đất), BẮT BUỘC phải viết câu nối giải thích rõ mối liên hệ trực tiếp với bước vừa làm xong:
  * Ví dụ 1: "Now that our field vise is locked down solid, we still need a proper grip for our file..."
  * Ví dụ 2: "With those dowels prepped, let's head to the dirt to anchor them down..."
  * Ví dụ 3: "Since the clamp frame is ready, this next scrap piece will give us the leverage we need..."
- TUYỆT ĐỐI KHÔNG dùng những cụm từ làm đứt gãy hoặc tách rời mạch truyện như "for a quick project", "in another project", "let's make something else" ở giữa video. Mọi thao tác, mọi chi tiết nhỏ từ câu 1 đến câu ${totalItems} đều phải phục vụ cho DUY NHẤT MỘT mục tiêu tổng thể đã gieo từ câu mở đầu!

===================================================================
4. QUY TẮC KỸ THUẬT BẤT DI BẤT DỊCH Ở BƯỚC 2
===================================================================
1. KHOÁ CỨNG 100% SỐ LƯỢNG CÂU VÀ MÃ "id": Nhận mảng đầu vào có ${totalItems} câu thì BẮT BUỘC trả ra đúng ${totalItems} câu với "id" giữ nguyên tuyệt đối từ 1 đến ${totalItems} (không xóa câu, không gộp câu, không bỏ sót bất kỳ id nào).
2. XỬ LÝ CÁC CÂU LIÊN TIẾP CÙNG QUAY MỘT CẢNH THAO TÁC DÀI: Nếu trong mảng đầu vào có những câu liên tiếp mô tả cùng một hành động/thao tác kéo dài (ví dụ: đang mài, đang cắt, đang siết ốc...), TUYỆT ĐỐI KHÔNG lặp lại mô tả hành động đó! Hãy tận dụng các câu tiếp nối đó để kể tiếp câu chuyện, chia sẻ lý do tại sao mẹo này hiệu quả, hoặc thả câu gây tò mò (Open Loop) cho bước kế tiếp! Nhờ vậy vừa khớp 100% hình ảnh trên video, vừa không bao giờ bị nhàm chán.
3. ĐỘ DÀI CHUẨN CHO NGƯỜI LỚN TUỔI: Mỗi câu "text" phải ngắn gọn, súc tích, dễ đọc (khoảng 8 - 15 từ/câu) và viết bằng ngôn ngữ: ${targetLangNote}.
4. ĐỊNH DẠNG ĐẦU RA: Chỉ trả về duy nhất mảng JSON hợp lệ theo cấu trúc: \`[{"id": 1, "text": "..."}, {"id": 2, "text": "..."}, ...]\`.

MẢNG JSON ĐẦU VÀO (${totalItems} PHẦN TỬ):
${JSON.stringify(payloadForAI, null, 2)}`;

        const maxAttempts = Math.max(4, candidates.length);
        const triedModelsInStep2 = new Set();
        let lastError = null;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            let currentModel = candidates.find(m => !triedModelsInStep2.has(m));
            if (!currentModel) {
                currentModel = candidates[attempt % candidates.length];
            }
            triedModelsInStep2.add(currentModel);

            const generateUrl = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${apiKey}`;

            const requestBody = JSON.stringify({
                system_instruction: {
                    parts: [
                        {
                            text: step2SystemInstruction
                        }
                    ]
                },
                contents: [
                    {
                        role: "user",
                        parts: [
                            { text: unifierPrompt }
                        ]
                    }
                ],
                generationConfig: {
                    temperature: 0.45,
                    maxOutputTokens: 8192,
                    responseMimeType: "application/json"
                }
            });

            try {
                addLog(`🧠 [Bước 2 - Lần ${attempt + 1}/${maxAttempts}] Đang gửi ${sourceItems.length} câu lên model "${currentModel}"...`, "info");
                const res = await makeHttpRequest(generateUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(requestBody)
                    }
                }, requestBody);

                if (res.statusCode < 200 || res.statusCode >= 300) {
                    throw new Error(`HTTP ${res.statusCode}: ${res.body}`);
                }

                const data = JSON.parse(res.body);
                const candidate = data.candidates?.[0];
                const rawText = extractCandidateText(candidate);
                if (!rawText || !rawText.trim()) {
                    throw new Error("API Bước 2 trả về nội dung rỗng.");
                }

                const rewrittenArray = parseJsonArrayFromAI(rawText);
                if (!Array.isArray(rewrittenArray) || rewrittenArray.length === 0) {
                    throw new Error("Không phân tích được mảng JSON hợp lệ từ kết quả Bước 2.");
                }

                const rewrittenMap = new Map();
                for (const entry of rewrittenArray) {
                    if (entry && entry.id !== undefined && typeof entry.text === 'string' && entry.text.trim().length > 0) {
                        rewrittenMap.set(Number(entry.id), entry.text.replace(/\r?\n/g, ' ').trim());
                    }
                }

                if (rewrittenMap.size === 0) {
                    throw new Error("Mảng JSON từ Bước 2 không chứa nội dung text hợp lệ.");
                }

                promoteWorkingModel(candidates, currentModel);

                // Ghép phần "text" đã biên tập vào đúng "time" gốc theo từng "id"
                const finalBlocks = sourceItems.map((origItem) => {
                    const refinedText = rewrittenMap.get(origItem.id) || origItem.text;
                    return `${origItem.id}\r\n${origItem.time}\r\n${refinedText}`;
                });

                return finalBlocks.join('\r\n\r\n') + '\r\n\r\n';
            } catch (err) {
                lastError = err;
                const errMsg = (err && err.message) ? err.message : String(err);
                demoteFailedModel(candidates, currentModel);

                if (attempt < maxAttempts - 1) {
                    const nextModel = candidates.find(m => !triedModelsInStep2.has(m)) || candidates[(attempt + 1) % candidates.length];
                    const waitSec = 2;
                    addLog(`⚠️ [Bước 2] Model "${currentModel}" không hoạt động (${errMsg.substring(0, 140)}). Tự động chuyển sang model "${nextModel}" sau ${waitSec}s...`, "warning");
                    await sleep(waitSec * 1000);
                }
            }
        }

        throw new Error(`Bước 2 (Storyline Unifier) thất bại sau khi thử ${maxAttempts} model: ${lastError ? lastError.message : 'Lỗi không xác định'}`);
    }

    function parseJsonArrayFromAI(rawText) {
        let cleaned = (rawText || '').trim();
        const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced && fenced[1]) {
            cleaned = fenced[1].trim();
        }
        const firstBracket = cleaned.indexOf('[');
        const lastBracket = cleaned.lastIndexOf(']');
        if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
            cleaned = cleaned.substring(firstBracket, lastBracket + 1);
        }
        return JSON.parse(cleaned);
    }

    function sanitizeSrtContent(content) {
        let text = (content || '').trim();
        const fencedMatch = text.match(/```(?:srt)?\s*([\s\S]*?)```/i);
        if (fencedMatch && fencedMatch[1] && fencedMatch[1].includes('-->')) {
            text = fencedMatch[1].trim();
        } else {
            text = text.replace(/^```(?:srt)?[\r\n]*/i, '');
            text = text.replace(/[\r\n]*```$/i, '');
            text = text.trim();
        }

        const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        let firstTimecodeIdx = -1;
        for (let i = 0; i < lines.length; i++) {
            if (/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(lines[i])) {
                firstTimecodeIdx = i;
                break;
            }
        }
        if (firstTimecodeIdx > 0) {
            const prevLine = lines[firstTimecodeIdx - 1].trim();
            const startIdx = /^\d+$/.test(prevLine) ? (firstTimecodeIdx - 1) : firstTimecodeIdx;
            text = lines.slice(startIdx).join('\n');
        } else {
            text = lines.join('\n');
        }

        text = text.trim().replace(/\n/g, '\r\n');
        if (!text.endsWith('\r\n\r\n')) {
            text += '\r\n\r\n';
        }
        return text;
    }

    // ==========================================
    // SRT TIMECODE SHIFTING & MERGING
    // ==========================================
    function parseTimeToMs(timeStr) {
        const parts = timeStr.trim().split(/[:,.]/);
        if (parts.length < 4) return 0;
        const h = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        const s = parseInt(parts[2], 10);
        const ms = parseInt(parts[3], 10);
        return (h * 3600 + m * 60 + s) * 1000 + ms;
    }

    function msToTimeStr(totalMs) {
        if (totalMs < 0) totalMs = 0;
        const h = Math.floor(totalMs / 3600000);
        const m = Math.floor((totalMs % 3600000) / 60000);
        const s = Math.floor((totalMs % 60000) / 1000);
        const ms = totalMs % 1000;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    }

    function shiftSrtTimecodes(srtText, offsetSeconds) {
        if (!offsetSeconds || Math.abs(offsetSeconds) < 0.0005) return srtText;
        const offsetMs = Math.round(offsetSeconds * 1000);
        const timecodeRegex = /(\d{2}:\d{2}:\d{2}[,. ]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,. ]\d{3})/g;

        return srtText.replace(timecodeRegex, (_match, startStr, endStr) => {
            const origStartMs = parseTimeToMs(startStr);
            const origEndMs = parseTimeToMs(endStr);
            const durMs = Math.max(500, origEndMs - origStartMs);
            const newStartMs = Math.max(0, origStartMs + offsetMs);
            const newEndMs = Math.max(newStartMs + durMs, origEndMs + offsetMs);
            return `${msToTimeStr(newStartMs)} --> ${msToTimeStr(newEndMs)}`;
        });
    }

    function mergeSrtChunks(srtChunks) {
        let globalIndex = 1;
        const combinedBlocks = [];

        for (const chunkSrt of srtChunks) {
            if (!chunkSrt || !chunkSrt.trim()) continue;
            const blocks = chunkSrt.trim().split(/\r?\n\r?\n/);
            for (const block of blocks) {
                const lines = block.trim().split(/\r?\n/);
                if (lines.length >= 2) {
                    let timecodeIndex = -1;
                    for (let l = 0; l < lines.length; l++) {
                        if (lines[l].includes('-->')) {
                            timecodeIndex = l;
                            break;
                        }
                    }
                    if (timecodeIndex !== -1) {
                        const timecode = lines[timecodeIndex];
                        const text = lines.slice(timecodeIndex + 1).join('\r\n');
                        if (text.trim().length > 0) {
                            combinedBlocks.push(`${globalIndex}\r\n${timecode}\r\n${text}`);
                            globalIndex++;
                        }
                    }
                }
            }
        }

        return combinedBlocks.join('\r\n\r\n') + '\r\n\r\n';
    }

    // ==========================================
    // SUBTITLE FORMATTING & WORD-WRAP
    // ==========================================
    function formatSubtitleText(srtContent, maxChars = 42, colorTag = '') {
        const blocks = srtContent.trim().split(/\r?\n\r?\n/);
        const formattedBlocks = [];

        for (const block of blocks) {
            const lines = block.trim().split(/\r?\n/);
            if (lines.length >= 3) {
                const index = lines[0];
                const timecode = lines[1];
                let text = lines.slice(2).join(' ').trim();

                text = text.replace(/<\/?[^>]+(>|$)/g, "");

                if (text.length > maxChars) {
                    const words = text.split(/\s+/);
                    let line1 = '';
                    let line2 = '';
                    const halfLength = Math.floor(text.length / 2);
                    let currentLen = 0;

                    for (let i = 0; i < words.length; i++) {
                        const word = words[i];
                        if (currentLen + word.length < halfLength || line1.length === 0) {
                            line1 += (line1.length > 0 ? ' ' : '') + word;
                            currentLen += word.length + 1;
                        } else {
                            line2 += (line2.length > 0 ? ' ' : '') + word;
                        }
                    }

                    text = line2.length > 0 ? `${line1}\r\n${line2}` : line1;
                }

                if (colorTag && colorTag.length > 0) {
                    const subLines = text.split(/\r?\n/);
                    text = subLines.map(l => `<font color="${colorTag}">${l}</font>`).join('\r\n');
                }

                formattedBlocks.push(`${index}\r\n${timecode}\r\n${text}`);
            } else {
                formattedBlocks.push(block);
            }
        }

        return formattedBlocks.join('\r\n\r\n') + '\r\n\r\n';
    }

    // ==========================================
    // GENERATE FINAL CUT PRO XML (XMEML) FOR GRAPHIC TRACK
    // ==========================================
    function parseSrtToCues(srt) {
        const cues = [];
        const blocks = (srt || '').trim().split(/\r?\n\r?\n/);

        for (const b of blocks) {
            const lines = b.trim().split(/\r?\n/);
            if (lines.length >= 2) {
                let tcLineIdx = -1;
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes('-->')) {
                        tcLineIdx = i;
                        break;
                    }
                }
                if (tcLineIdx !== -1) {
                    const timeMatch = lines[tcLineIdx].match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
                    if (timeMatch) {
                        const startSec = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]) + parseInt(timeMatch[4]) / 1000;
                        const endSec = parseInt(timeMatch[5]) * 3600 + parseInt(timeMatch[6]) * 60 + parseInt(timeMatch[7]) + parseInt(timeMatch[8]) / 1000;
                        const rawText = lines.slice(tcLineIdx + 1).join('\n').replace(/<\/?[^>]+(>|$)/g, "").trim();

                        if (rawText.length > 0) {
                            cues.push({
                                index: cues.length + 1,
                                startSec,
                                endSec,
                                text: rawText
                            });
                        }
                    }
                }
            }
        }
        return cues;
    }

    function generateStyledXMLFromSRT(finalSrtContent, styleOptions, seqSettings, timestamp = Date.now()) {
        const cues = parseSrtToCues(finalSrtContent);
        const timebase = seqSettings.timebase || 30;
        const isNtsc = (Math.abs((seqSettings.fps || 30) - 29.97) < 0.1 || Math.abs((seqSettings.fps || 30) - 23.976) < 0.1) ? 'TRUE' : 'FALSE';
        const width = seqSettings.width || 1920;
        const height = seqSettings.height || 1080;
        const totalDurationSec = cues.length > 0 ? cues[cues.length - 1].endSec : 0;
        const totalFrames = Math.max(1, Math.round(totalDurationSec * timebase));
        const uniqueSeqName = `ActionSub_Graphic_Track_${timestamp}`;

        const textColor = hexToRgb(styleOptions.color || '#FFFFFF');
        const vertPos = (((styleOptions.posY || 85) - 50) / 50).toFixed(3);

        let clipItemsXml = '';

        for (const c of cues) {
            const startFrame = Math.round(c.startSec * timebase);
            const endFrame = Math.round(c.endSec * timebase);
            const durFrames = Math.max(1, endFrame - startFrame);
            const cleanTitle = c.text.replace(/\r?\n/g, ' ').replace(/[<>&"']/g, '');

            clipItemsXml += `
            <clipitem id="clipitem-${timestamp}-${c.index}">
              <name>${escapeXml(cleanTitle)}</name>
              <duration>${durFrames}</duration>
              <rate><timebase>${timebase}</timebase><ntsc>${isNtsc}</ntsc></rate>
              <start>${startFrame}</start>
              <end>${endFrame}</end>
              <in>0</in>
              <out>${durFrames}</out>
              <effect>
                <name>Basic Title</name>
                <effectid>Text</effectid>
                <effecttype>generator</effecttype>
                <mediatype>video</mediatype>
                <parameter>
                  <parameterid>str</parameterid>
                  <name>Text</name>
                  <value>${escapeXml(c.text)}</value>
                </parameter>
                <parameter>
                  <parameterid>font</parameterid>
                  <name>Font</name>
                  <value>${escapeXml(styleOptions.font || 'Arial-BoldMT')}</value>
                </parameter>
                <parameter>
                  <parameterid>size</parameterid>
                  <name>Size</name>
                  <value>${styleOptions.size || 65}</value>
                </parameter>
                <parameter>
                  <parameterid>style</parameterid>
                  <name>Style</name>
                  <value>Bold</value>
                </parameter>
                <parameter>
                  <parameterid>align</parameterid>
                  <name>Alignment</name>
                  <value>Center</value>
                </parameter>
                <parameter>
                  <parameterid>color</parameterid>
                  <name>Color</name>
                  <value>
                    <alpha>255</alpha>
                    <red>${textColor.r}</red>
                    <green>${textColor.g}</green>
                    <blue>${textColor.b}</blue>
                  </value>
                </parameter>
                <parameter>
                  <parameterid>origin</parameterid>
                  <name>Origin</name>
                  <value>
                    <horiz>0</horiz>
                    <vert>${vertPos}</vert>
                  </value>
                </parameter>
              </effect>
            </clipitem>`;
        }

        return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-action-sub-${timestamp}">
    <name>${uniqueSeqName}</name>
    <duration>${totalFrames}</duration>
    <rate>
      <timebase>${timebase}</timebase>
      <ntsc>${isNtsc}</ntsc>
    </rate>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            <rate>
              <timebase>${timebase}</timebase>
              <ntsc>${isNtsc}</ntsc>
            </rate>
            <width>${width}</width>
            <height>${height}</height>
            <anamorphic>FALSE</anamorphic>
            <pixelaspectratio>square</pixelaspectratio>
          </samplecharacteristics>
        </format>
        <track>
          ${clipItemsXml}
        </track>
      </video>
    </media>
  </sequence>
</xmeml>`;
    }

    // ==========================================
    // CLEANUP GOOGLE SERVER FILE
    // ==========================================
    async function deleteGeminiFile(fileName, apiKey) {
        try {
            const deleteUrl = `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`;
            await makeHttpRequest(deleteUrl, { method: 'DELETE' });
        } catch (e) {
            console.warn("Could not delete file from Google:", e);
        }
    }

    function normalizeChunkLocalTimecodes(chunkSrt, chunkOffsetSec, chunkDurationSec) {
        const cues = parseSrtBlocksStrict(chunkSrt);
        if (cues.length === 0) return chunkSrt;

        const tcRegex = /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/;
        const maxChunkMs = Math.round((chunkDurationSec + 2) * 1000);
        const offsetMs = Math.round(chunkOffsetSec * 1000);

        const items = cues.map((c) => {
            const m = c.timecode.match(tcRegex);
            const startMs = m ? parseTimeToMs(m[1]) : 0;
            const endMs = m ? parseTimeToMs(m[2]) : (startMs + 2500);
            return { startMs, endMs, text: c.text };
        });

        // Nếu AI cộng sẵn offset vào chunk > 0 thì đưa về đồng hồ nội bộ 0..chunkDurationSec trước khi cộng chuẩn
        if (chunkOffsetSec > 30 && items[0].startMs >= offsetMs - 3000) {
            for (const it of items) {
                it.startMs = Math.max(0, it.startMs - offsetMs);
                it.endMs = Math.max(it.startMs + 1500, it.endMs - offsetMs);
            }
        }

        const MIN_DUR_MS = 2000;
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (it.startMs > maxChunkMs - 800) {
                it.startMs = Math.max(0, maxChunkMs - 2000);
            }
            const nextStart = (i < items.length - 1) ? items[i + 1].startMs : maxChunkMs;
            if (it.endMs - it.startMs < MIN_DUR_MS) {
                it.endMs = Math.min(it.startMs + MIN_DUR_MS, Math.max(it.startMs + 1000, nextStart - 80));
            }
            if (it.endMs > maxChunkMs) {
                it.endMs = maxChunkMs;
            }
        }

        return items.map((it, idx) => `${idx + 1}\r\n${msToTimeStr(it.startMs)} --> ${msToTimeStr(it.endMs)}\r\n${it.text}`).join('\r\n\r\n') + '\r\n\r\n';
    }

    // ==========================================
    // ĐIỀU PHỐI BƯỚC 1: TÁCH CHUNK & GỬI SONG SONG (TỰ ĐỘNG CHUYỂN ĐỔI ĐA MODEL)
    // ==========================================
    async function processChunks(masterVideoPath, totalDuration, useFfmpeg, apiKey, systemPrompt, selectedLanguage, modelCandidates, storyContextValue, tempFilesTracker, uploadedFileResources) {
        const CHUNK_DURATION = 90;
        const CONCURRENCY_LIMIT = 4;
        const shouldChunk = totalDuration > 95 && useFfmpeg;
        let srtChunksResults = [];
        const activePrimary = Array.isArray(modelCandidates) ? modelCandidates[0] : modelCandidates;

        if (!shouldChunk) {
            const measuredMasterDur = await getActualVideoDurationSec(masterVideoPath);
            const effectiveDuration = (measuredMasterDur && measuredMasterDur > 0) ? measuredMasterDur : totalDuration;

            addLog(`BƯỚC 1: Video dài ${effectiveDuration.toFixed(2)}s, gửi trực tiếp lên ${activePrimary}...`, "step");
            const fallbackOptions = { sourcePath: masterVideoPath, startSec: 0, durationSec: effectiveDuration };
            const { activeFile, uploadedFile } = await uploadAndActivateVideo(masterVideoPath, apiKey, fallbackOptions, tempFilesTracker);
            uploadedFileResources.push(uploadedFile);

            const srtResult = await generateChunkWithRetry(
                activeFile.uri, apiKey, systemPrompt, selectedLanguage, modelCandidates, effectiveDuration, 0, 1, storyContextValue
            );
            deleteGeminiFile(uploadedFile.name, apiKey);
            const normalizedSingle = normalizeChunkLocalTimecodes(srtResult, 0, effectiveDuration);
            srtChunksResults.push({ chunkIndex: 0, srt: normalizedSingle });
        } else {
            const chunkItems = await segmentVideoIntoChunks(masterVideoPath, totalDuration, CHUNK_DURATION, tempFilesTracker);
            const totalChunks = chunkItems.length;
            const chunkOffsets = chunkItems.map(c => c.offsetSec);

            addLog(`BƯỚC 1: Gửi song song ${totalChunks} phân đoạn (Model ưu tiên: ${activePrimary}, tự động chuyển đổi sang ${modelCandidates.length - 1} model khác nếu lỗi)...`, "step");
            setProgress(25);

            let completedChunksCount = 0;
            let abortWorkers = false;

            const processOneChunk = async (chunk) => {
                const { chunkIndex, chunkPath, actualDurationSec, planStartSec, planDurationSec } = chunk;
                const exactChunkOffsetSec = chunkOffsets[chunkIndex];
                const chunkLabel = `[Phân đoạn ${chunkIndex + 1}/${totalChunks}]`;
                const timeRangeStr = `${formatSecondsToMMSS(exactChunkOffsetSec)} ➔ ${formatSecondsToMMSS(exactChunkOffsetSec + actualDurationSec)}`;
                const sliceStart = (planStartSec !== undefined) ? planStartSec : exactChunkOffsetSec;
                const sliceDur = (planDurationSec !== undefined) ? planDurationSec : actualDurationSec;

                try {
                    // Tự động phục hồi file phân đoạn nếu bị hệ thống/trình dọn rác xoá khỏi thư mục tạm trong lúc chờ các chunk trước
                    if (!fs.existsSync(chunkPath) || fs.statSync(chunkPath).size < 1024) {
                        addLog(`🔄 ${chunkLabel} Phát hiện file tạm bị thiếu, đang tự động cắt lại phân đoạn (${timeRangeStr})...`, "warning");
                        const dirOfChunk = path.dirname(chunkPath);
                        if (!fs.existsSync(dirOfChunk)) {
                            fs.mkdirSync(dirOfChunk, { recursive: true });
                        }
                        await extractSingleChunkVideo(masterVideoPath, sliceStart, sliceDur, chunkPath);
                    }

                    const chunkSize = fs.existsSync(chunkPath) ? fs.statSync(chunkPath).size : 0;
                    addLog(`🚀 ${chunkLabel} Upload (${formatBytes(chunkSize)}, ${timeRangeStr})...`, "dim");
                    const fallbackOptions = { sourcePath: masterVideoPath, startSec: sliceStart, durationSec: sliceDur };
                    const { activeFile, uploadedFile } = await uploadAndActivateVideo(chunkPath, apiKey, fallbackOptions, tempFilesTracker);
                    uploadedFileResources.push(uploadedFile);

                    const chunkRawSrt = await generateChunkWithRetry(
                        activeFile.uri, apiKey, systemPrompt, selectedLanguage, modelCandidates, actualDurationSec, chunkIndex, totalChunks, storyContextValue
                    );

                    deleteGeminiFile(uploadedFile.name, apiKey);

                    const normalizedLocalSrt = normalizeChunkLocalTimecodes(chunkRawSrt, exactChunkOffsetSec, actualDurationSec);
                    const shiftedSrt = shiftSrtTimecodes(normalizedLocalSrt, exactChunkOffsetSec);
                    const chunkCueCount = parseSrtBlocksStrict(shiftedSrt).length;

                    completedChunksCount++;
                    const currentProgress = Math.floor(25 + (completedChunksCount / totalChunks) * 60);
                    setProgress(currentProgress);

                    addLog(`✅ ${chunkLabel} Hoàn tất ${timeRangeStr}: ${chunkCueCount} câu phụ đề (${completedChunksCount}/${totalChunks})`, "success");

                    return {
                        chunkIndex: chunkIndex,
                        srt: shiftedSrt
                    };
                } catch (err) {
                    abortWorkers = true;
                    addLog(`❌ ${chunkLabel} Thất bại: ${err.message}`, "error");
                    throw err;
                }
            };

            const results = new Array(totalChunks);
            let nextIdx = 0;
            const workerCount = Math.min(CONCURRENCY_LIMIT, totalChunks);
            const workers = Array.from({ length: workerCount }, async () => {
                while (nextIdx < totalChunks && !abortWorkers) {
                    const currentIdx = nextIdx++;
                    if (currentIdx < totalChunks) {
                        results[currentIdx] = await processOneChunk(chunkItems[currentIdx]);
                    }
                }
            });

            // Đợi TẤT CẢ các worker đang chạy kết thúc hẳn rồi mới cho phép chuyển tiếp hoặc dọn file tạm trong finally
            const settledWorkers = await Promise.allSettled(workers);
            const rejectedWorker = settledWorkers.find(s => s.status === 'rejected');
            if (rejectedWorker) {
                throw rejectedWorker.reason;
            }
            srtChunksResults = results;
        }

        srtChunksResults.sort((a, b) => a.chunkIndex - b.chunkIndex);
        const orderedSrtList = srtChunksResults.map(r => r.srt);

        return mergeSrtChunks(orderedSrtList);
    }

    // ==========================================
    // MAIN WORKFLOW ORCHESTRATION (2 BƯỚC AI TINH GỌN)
    // ==========================================
    async function startWorkflow() {
        const apiKey = apiKeyInput.value.trim();
        if (!apiKey) {
            addLog("Lỗi: Vui lòng nhập Google Gemini API Key!", "error");
            apiKeyInput.focus();
            return;
        }

        const selectedLanguage = targetLanguageSelect.value === 'custom'
            ? (customLanguageInput.value.trim() || 'Tiếng Việt')
            : targetLanguageSelect.value;

        const currentPersona = personaModeSelect ? personaModeSelect.value : 'standard';
        const storyContextValue = storyContextInput ? storyContextInput.value.trim() : '';
        const defaultPromptForMode = (currentPersona === 'us_senior_diy') ? US_SENIOR_DIY_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT;
        const systemPrompt = systemPromptInput.value.trim() || defaultPromptForMode;
        const useFfmpeg = enableFfmpegCheckbox.checked;
        const primaryModel = resolvePrimaryModel(modelNameInput ? modelNameInput.value : 'gemini-3.8-flash');

        const shouldAutoInsert = autoInsertTimeline ? autoInsertTimeline.checked : true;
        const currentInsertMode = insertMode ? insertMode.value : 'caption_track';
        const styleOptions = {
            font: (subFont ? subFont.value.trim() : '') || 'Arial-BoldMT',
            size: parseInt(subSize ? subSize.value : '65') || 65,
            color: (subColor ? subColor.value : '#FFFFFF') || '#FFFFFF',
            strokeColor: (subStrokeColor ? subStrokeColor.value : '#000000') || '#000000',
            strokeWidth: parseInt(subStrokeWidth ? subStrokeWidth.value : '8') || 8,
            posY: parseInt(subPosY ? subPosY.value : '85') || 85,
            maxChars: parseInt(maxCharsPerLine ? maxCharsPerLine.value : '42') || 42
        };

        saveSettings();
        setProcessingState(true, "Đang xử lý...");
        clearLog();

        const tempFilesTracker = [];
        const uploadedFileResources = [];

        try {
            // ----------------------------------------------------
            // BƯỚC 1: Chuẩn bị video chuẩn thời gian -> Tách phân đoạn -> AI quan sát hành động thực tế
            // ----------------------------------------------------
            addLog("BƯỚC 1/2: Kiểm tra Sequence & chuẩn bị video chuẩn thời gian...", "step");
            const clipInfo = await callExtendScript('getSelectedClipInfo()');

            if (!clipInfo.success) {
                throw new Error(clipInfo.error || "Không thể lấy thông tin Sequence/Clip từ Premiere.");
            }

            const clips = clipInfo.clips && clipInfo.clips.length > 0
                ? clipInfo.clips
                : [{ mediaPath: clipInfo.mediaPath, inPoint: 0, outPoint: 0, duration: 0, name: clipInfo.name }];

            const totalDuration = clipInfo.totalDurationSeconds || 0;
            const firstClipStartSeconds = Number(clipInfo.firstClipStartSeconds) || 0;
            const seqSettings = clipInfo.sequenceSettings || { width: 1920, height: 1080, fps: 29.97, timebase: 30 };

            addLog(`Sequence: "${clipInfo.sequenceName || clipInfo.name}" | Tổng thời lượng: ${formatSecondsToMMSS(totalDuration)}`, "info");

            const masterVideoPath = await prepareMasterVideoForAI(clips, useFfmpeg, tempFilesTracker, clipInfo);
            const effectiveTotalDuration = Number(clipInfo.verifiedMasterDurationSec) || totalDuration;
            const effectiveTimelineInsertStartSec = clipInfo.renderedViaPremiereDirect ? 0 : firstClipStartSeconds;

            const modelCandidates = await getModelCandidates(apiKey, primaryModel);
            addLog(`🤖 Danh sách model sẵn sàng (${modelCandidates.length}): Ưu tiên "${modelCandidates[0]}", dự phòng tự động: [${modelCandidates.slice(1, 6).join(', ')}]`, "info");

            const rawSrt = await processChunks(
                masterVideoPath, effectiveTotalDuration, useFfmpeg, apiKey, systemPrompt, selectedLanguage, modelCandidates, storyContextValue, tempFilesTracker, uploadedFileResources
            );

            // ----------------------------------------------------
            // BƯỚC 2: Biên tập nối mạch truyện xuyên suốt (Khoá cứng Timestamp) -> Xuất Sub (.SRT) lên Timeline
            // ----------------------------------------------------
            setProgress(88);
            const refinedSrt = await unifyAndRefineStoryline(
                rawSrt, currentPersona, storyContextValue, selectedLanguage, apiKey, modelCandidates
            );

            const colorTag = (currentInsertMode === 'caption_track' && styleOptions.color !== '#ffffff') ? styleOptions.color : '';
            const finalSrt = formatSubtitleText(refinedSrt, styleOptions.maxChars, colorTag);

            const finalCuesCount = parseSrtBlocksStrict(finalSrt).length;
            addLog(`✅ Hoàn tất Bước 2: Đã biên tập mạch truyện liền mạch cho ${finalCuesCount} câu phụ đề (giữ nguyên 100% mốc thời gian gốc).`, "success");

            // Lưu thành file .srt mới (kèm timestamp ở tên file để chống cache của Premiere)
            setProgress(95);
            const originalMediaPath = clips[0].mediaPath;
            const originalDir = path.dirname(originalMediaPath);
            const baseName = clipInfo.sequenceName
                ? clipInfo.sequenceName.replace(/[\\/:*?"<>|]/g, '_')
                : path.basename(originalMediaPath, path.extname(originalMediaPath));

            const runTimestamp = Date.now();
            const srtFileName = `${baseName}_sub_${runTimestamp}.srt`;
            const finalSrtPath = path.join(originalDir, srtFileName);
            fs.writeFileSync(finalSrtPath, finalSrt, 'utf-8');
            addLog(`Đã lưu file SRT tại: ${finalSrtPath}`, "success");

            let finalXmlPath = '';
            if (currentInsertMode === 'xml_graphic_track') {
                const xmlContent = generateStyledXMLFromSRT(finalSrt, styleOptions, seqSettings, runTimestamp);
                const xmlFileName = `${baseName}_sub_${runTimestamp}.xml`;
                finalXmlPath = path.join(originalDir, xmlFileName);
                fs.writeFileSync(finalXmlPath, xmlContent, 'utf-8');
                addLog(`Đã tạo file Graphic XML tại: ${finalXmlPath}`, "success");
            }

            if (shouldAutoInsert) {
                const escapedSrtPath = finalSrtPath.replace(/\\/g, '\\\\');
                const escapedXmlPath = finalXmlPath ? finalXmlPath.replace(/\\/g, '\\\\') : '';
                const styleJsonStr = JSON.stringify(styleOptions).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

                const insertRes = await callExtendScript(
                    `importAndInsertToTimeline("${escapedSrtPath}", "${escapedXmlPath}", "${currentInsertMode}", "${styleJsonStr}", "${runTimestamp}", ${effectiveTimelineInsertStartSec})`
                );

                if (insertRes.success) {
                    addLog(`🎉 ${insertRes.message}`, "success");
                } else {
                    addLog(`⚠️ ${insertRes.error || insertRes.message}`, "warning");
                }
            } else {
                addLog("Chế độ tự động chèn Timeline đang tắt. Bạn có thể kéo file .srt vào Premiere thủ công.", "info");
            }

            setProgress(100);
        } catch (err) {
            console.error("Workflow error:", err);
            addLog(`❌ LỖI: ${err.message}`, "error");
        } finally {
            for (const resFile of uploadedFileResources) {
                if (resFile && resFile.name) {
                    deleteGeminiFile(resFile.name, apiKey);
                }
            }

            for (const tmpPath of tempFilesTracker) {
                try {
                    if (fs.existsSync(tmpPath)) {
                        fs.unlinkSync(tmpPath);
                    }
                } catch (e) {
                    console.warn("Lỗi xoá file tạm:", tmpPath, e);
                }
            }

            setProcessingState(false);
        }
    }

    // Run on startup
    initSettings();

})();
