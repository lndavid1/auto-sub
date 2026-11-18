/**
 * host.jsx - Adobe Premiere Pro ExtendScript Host for ActionSubGemini
 * Compatibility: Premiere Pro CC 2020 (14.0) to 2025+
 */

// Đảm bảo không lỗi nếu JSON chưa tồn tại trong môi trường ExtendScript cũ
if (typeof JSON === 'undefined') {
    JSON = {
        stringify: function(val) {
            if (val === null) return 'null';
            if (typeof val === 'number' || typeof val === 'boolean') return String(val);
            if (typeof val === 'string') {
                return '"' + val.replace(/\\/g, '\\\\')
                                .replace(/"/g, '\\"')
                                .replace(/\n/g, '\\n')
                                .replace(/\r/g, '\\r')
                                .replace(/\t/g, '\\t') + '"';
            }
            if (val instanceof Array) {
                var res = [];
                for (var i = 0; i < val.length; i++) {
                    res.push(JSON.stringify(val[i]));
                }
                return '[' + res.join(',') + ']';
            }
            if (typeof val === 'object') {
                var pairs = [];
                for (var key in val) {
                    if (val.hasOwnProperty(key)) {
                        pairs.push('"' + key + '":' + JSON.stringify(val[key]));
                    }
                }
                return '{' + pairs.join(',') + '}';
            }
            return '""';
        }
    };
}

/**
 * Tìm ProjectItem đệ quy theo đường dẫn file hoặc tên (Duyệt ngược từ mới nhất về cũ nhất để tránh lấy nhầm bản cache cũ)
 */
function findItemInProject(rootItem, targetPath, targetName) {
    if (!rootItem || !rootItem.children) return null;
    for (var i = rootItem.children.numItems - 1; i >= 0; i--) {
        var child = rootItem.children[i];
        if (child) {
            var mPath = child.getMediaPath ? child.getMediaPath() : "";
            if (targetPath && mPath && mPath.toLowerCase() === targetPath.toLowerCase()) {
                return child;
            }
            if (targetName && child.name && child.name.toLowerCase() === targetName.toLowerCase()) {
                return child;
            }
            if (child.type === ProjectItemType.BIN || child.children) {
                var found = findItemInProject(child, targetPath, targetName);
                if (found) return found;
            }
        }
    }
    return null;
}

/**
 * Tính thời lượng thực tế (giây) của Active Sequence từ activeSeq.end (Ticks) và điểm cuối của tất cả clip
 */
function getSequenceRealDurationSeconds(activeSeq) {
    if (!activeSeq) return 0;
    var TICKS_PER_SECOND = 254016000000;
    var seqEndSec = 0;

    try {
        if (activeSeq.end !== undefined && activeSeq.end !== null) {
            if (typeof activeSeq.end === 'object' && activeSeq.end.seconds !== undefined) {
                seqEndSec = Number(activeSeq.end.seconds) || 0;
            } else {
                var endTicks = Number(activeSeq.end);
                var zeroTicks = (activeSeq.zeroPoint !== undefined && activeSeq.zeroPoint !== null) ? Number(activeSeq.zeroPoint) : 0;
                if (!isNaN(endTicks) && endTicks > 0) {
                    if (endTicks > 10000000) {
                        seqEndSec = (endTicks - (isNaN(zeroTicks) ? 0 : zeroTicks)) / TICKS_PER_SECOND;
                    } else {
                        seqEndSec = endTicks;
                    }
                }
            }
        }
    } catch (e) {}

    // Quét thêm điểm kết thúc lớn nhất của mọi Video/Audio track để đảm bảo chính xác 100%
    var maxTrackEndSec = 0;
    try {
        if (activeSeq.videoTracks) {
            for (var t = 0; t < activeSeq.videoTracks.numTracks; t++) {
                var vTrack = activeSeq.videoTracks[t];
                if (vTrack && vTrack.clips && vTrack.clips.numItems > 0) {
                    for (var c = 0; c < vTrack.clips.numItems; c++) {
                        var clip = vTrack.clips[c];
                        if (clip && clip.end && clip.end.seconds !== undefined) {
                            var cEnd = Number(clip.end.seconds) || 0;
                            if (cEnd > maxTrackEndSec) maxTrackEndSec = cEnd;
                        }
                    }
                }
            }
        }
    } catch (e2) {}

    var finalDur = (seqEndSec > 0) ? seqEndSec : maxTrackEndSec;
    if (maxTrackEndSec > finalDur) {
        finalDur = maxTrackEndSec;
    }
    return Math.round(finalDur * 1000) / 1000;
}

/**
 * Lấy danh sách toàn bộ các clip được chọn hoặc toàn bộ Sequence trên Timeline
 * Đồng thời trích xuất thông số Sequence Settings (Width, Height, FPS) để tạo XML chuẩn
 */
function getSelectedClipInfo() {
    try {
        if (!app.project) {
            return JSON.stringify({
                success: false,
                error: "Chưa mở dự án Premiere Pro nào. Vui lòng mở Project."
            });
        }

        var collectedClips = [];
        var activeSeq = app.project.activeSequence;

        // Trích xuất Sequence Settings
        var seqSettingsData = {
            width: 1920,
            height: 1080,
            fps: 29.97,
            timebase: 30
        };

        if (activeSeq && activeSeq.getSettings) {
            var sSettings = activeSeq.getSettings();
            if (sSettings) {
                if (sSettings.videoFrameWidth) seqSettingsData.width = Number(sSettings.videoFrameWidth);
                if (sSettings.videoFrameHeight) seqSettingsData.height = Number(sSettings.videoFrameHeight);
                if (sSettings.videoFrameRate && sSettings.videoFrameRate.seconds) {
                    var secPerFrame = Number(sSettings.videoFrameRate.seconds);
                    if (secPerFrame > 0) {
                        seqSettingsData.fps = Math.round((1 / secPerFrame) * 100) / 100;
                        seqSettingsData.timebase = Math.round(seqSettingsData.fps);
                    }
                }
            }
        }

        // -------------------------------------------------------------
        // TRƯỜNG HỢP 1: KIỂM TRA TRÊN ACTIVE SEQUENCE (TIMELINE)
        // -------------------------------------------------------------
        if (activeSeq && activeSeq.videoTracks) {
            var selectedTimelineClips = [];
            var allTimelineClips = [];

            // Duyệt qua tất cả các video track trên Timeline
            for (var t = 0; t < activeSeq.videoTracks.numTracks; t++) {
                var track = activeSeq.videoTracks[t];
                if (track && track.clips) {
                    for (var c = 0; c < track.clips.numItems; c++) {
                        var trackClip = track.clips[c];
                        if (trackClip && trackClip.projectItem) {
                            var mPath = trackClip.projectItem.getMediaPath ? trackClip.projectItem.getMediaPath() : "";
                            if (mPath && mPath.length > 0) {
                                var fileObj = new File(mPath);
                                if (fileObj.exists) {
                                    var srcIn = trackClip.inPoint ? Number(trackClip.inPoint.seconds) : 0;
                                    var srcOut = trackClip.outPoint ? Number(trackClip.outPoint.seconds) : 0;
                                    var seqStart = trackClip.start ? Number(trackClip.start.seconds) : 0;
                                    var seqEnd = trackClip.end ? Number(trackClip.end.seconds) : 0;
                                    var durSec = (seqEnd > seqStart) ? (seqEnd - seqStart) : ((srcOut > srcIn) ? (srcOut - srcIn) : 0);

                                    var clipData = {
                                        name: trackClip.name || trackClip.projectItem.name,
                                        mediaPath: mPath,
                                        seqStart: seqStart,
                                        seqEnd: seqEnd,
                                        srcIn: srcIn,
                                        srcOut: srcOut,
                                        inPoint: srcIn,
                                        outPoint: srcOut,
                                        start: seqStart,
                                        end: seqEnd,
                                        duration: durSec,
                                        trackIndex: t,
                                        nodeId: trackClip.projectItem.nodeId || ""
                                    };

                                    allTimelineClips.push(clipData);

                                    if (trackClip.isSelected && trackClip.isSelected()) {
                                        selectedTimelineClips.push(clipData);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Luôn lấy đầy đủ 100% toàn bộ các clip trên Active Sequence để render và tạo phụ đề trọn vẹn từ đầu đến cuối
            if (allTimelineClips.length > 0) {
                collectedClips = allTimelineClips;
            } else if (selectedTimelineClips.length > 0) {
                collectedClips = selectedTimelineClips;
            }

            if (collectedClips.length > 0) {
                // Sắp xếp các clip theo thứ tự thời gian xuất hiện trên timeline (start)
                collectedClips.sort(function(a, b) {
                    if (a.start !== b.start) {
                        return a.start - b.start;
                    }
                    return a.trackIndex - b.trackIndex;
                });

                var totalTimelineDuration = 0;
                var minStart = collectedClips[0].start;
                var maxEnd = collectedClips[0].end;

                for (var k = 0; k < collectedClips.length; k++) {
                    if (collectedClips[k].start < minStart) minStart = collectedClips[k].start;
                    if (collectedClips[k].end > maxEnd) maxEnd = collectedClips[k].end;
                    totalTimelineDuration += collectedClips[k].duration;
                }

                var spanDuration = (maxEnd > minStart) ? (maxEnd - minStart) : totalTimelineDuration;
                var seqRealDurSec = getSequenceRealDurationSeconds(activeSeq);
                var effectiveTotalDuration = (seqRealDurSec > spanDuration) ? seqRealDurSec : spanDuration;
                var firstClipStartSec = Math.max(0, Math.round(minStart * 1000) / 1000);

                return JSON.stringify({
                    success: true,
                    hasActiveSequence: true,
                    sourceType: "timeline_all",
                    sequenceName: activeSeq.name,
                    sequenceDurationSeconds: Math.round(effectiveTotalDuration * 1000) / 1000,
                    totalClips: collectedClips.length,
                    totalDurationSeconds: Math.round(effectiveTotalDuration * 1000) / 1000,
                    firstClipStartSeconds: firstClipStartSec,
                    clips: collectedClips,
                    mediaPath: collectedClips[0].mediaPath,
                    name: (collectedClips.length === 1) ? collectedClips[0].name : (activeSeq.name + " (" + collectedClips.length + " clips)"),
                    sequenceSettings: seqSettingsData
                });
            }
        }

        // -------------------------------------------------------------
        // TRƯỜNG HỢP 2: KIỂM TRA TRONG PROJECT PANEL
        // -------------------------------------------------------------
        var projectPanelClips = [];
        if (app.getProjectViewIDs && app.getProjectItemsFromViewID) {
            var viewIDs = app.getProjectViewIDs();
            if (viewIDs && viewIDs.length > 0) {
                for (var v = 0; v < viewIDs.length; v++) {
                    var items = app.getProjectItemsFromViewID(viewIDs[v]);
                    if (items && items.length > 0) {
                        for (var i = 0; i < items.length; i++) {
                            var item = items[i];
                            if (item) {
                                var pPath = item.getMediaPath ? item.getMediaPath() : "";
                                if (pPath && pPath.length > 0) {
                                    var fObj = new File(pPath);
                                    if (fObj.exists) {
                                        projectPanelClips.push({
                                            name: item.name || fObj.name,
                                            mediaPath: pPath,
                                            seqStart: 0,
                                            seqEnd: 0,
                                            srcIn: 0,
                                            srcOut: 0,
                                            inPoint: 0,
                                            outPoint: 0,
                                            start: 0,
                                            end: 0,
                                            duration: 0,
                                            sizeBytes: fObj.length
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if (projectPanelClips.length > 0) {
            return JSON.stringify({
                success: true,
                sourceType: "project_panel",
                sequenceName: "",
                totalClips: projectPanelClips.length,
                totalDurationSeconds: 0,
                firstClipStartSeconds: 0,
                clips: projectPanelClips,
                mediaPath: projectPanelClips[0].mediaPath,
                name: projectPanelClips[0].name,
                sequenceSettings: seqSettingsData
            });
        }

        return JSON.stringify({
            success: false,
            error: "Không tìm thấy clip nào đang được chọn hoặc Sequence rỗng. Vui lòng mở Sequence hoặc chọn clip trong Project Panel."
        });

    } catch (e) {
        return JSON.stringify({
            success: false,
            error: "Lỗi ExtendScript getSelectedClipInfo: " + e.toString() + " (Line: " + e.line + ")"
        });
    }
}

/**
 * Import phụ đề và tự động chèn vào Active Sequence Timeline
 * @param {string} srtPath Đường dẫn tuyệt đối file .srt
 * @param {string} xmlPath Đường dẫn tuyệt đối file .xml (chế độ graphic track)
 * @param {string} mode 'caption_track' hoặc 'xml_graphic_track'
 * @param {string} styleJsonStr Chuỗi JSON tuỳ chọn kiểu chữ
 */
function importAndInsertToTimeline(srtPath, xmlPath, mode, styleJsonStr, runTimestamp, firstClipStartSeconds) {
    try {
        if (!app.project) {
            return JSON.stringify({
                success: false,
                error: "Chưa mở dự án Premiere Pro."
            });
        }

        var activeSeq = app.project.activeSequence;
        var targetBin = app.project.rootItem;
        var expectedGraphicSeqName = runTimestamp ? ("ActionSub_Graphic_Track_" + runTimestamp) : "ActionSub_Graphic_Track";
        var timelineStartOffset = Math.max(0, Number(firstClipStartSeconds) || 0);

        // -------------------------------------------------------------
        // CHẾ ĐỘ 1: CHÈN CAPTION TRACK (CHUẨN PREMIERE PRO CAPTION TRACK)
        // -------------------------------------------------------------
        if (mode === 'caption_track' || !xmlPath || xmlPath.length === 0) {
            var srtFile = new File(srtPath);
            if (!srtFile.exists) {
                return JSON.stringify({ success: false, error: "File SRT không tồn tại: " + srtPath });
            }

            // 1. Import file SRT mới (có gắn timestamp chống cache) vào Project
            var importSuccess = app.project.importFiles([srtPath], true, targetBin, false);
            var srtItem = findItemInProject(app.project.rootItem, srtPath, srtFile.name);

            // 2. Tự động đẩy lên Timeline tại đúng vị trí firstClipStartSeconds nếu có Active Sequence
            var timelineInserted = false;
            if (activeSeq && srtItem) {
                // Premiere Pro CC 2021+ (15.0+) hỗ trợ hàm tạo caption track trực tiếp
                if (activeSeq.createCaptionTrack) {
                    try {
                        var trackCreated = activeSeq.createCaptionTrack(srtItem, timelineStartOffset);
                        if (trackCreated) {
                            timelineInserted = true;
                        }
                    } catch (trackErr) {
                        // ignore
                    }
                }
            }

            if (timelineInserted) {
                return JSON.stringify({
                    success: true,
                    mode: 'caption_track',
                    message: "Đã tạo Caption Track mới (" + srtFile.name + ") và đặt phụ đề Bước 2 tại " + timelineStartOffset.toFixed(2) + "s của Sequence!",
                    inserted: true
                });
            } else {
                return JSON.stringify({
                    success: true,
                    mode: 'caption_track',
                    message: "Đã import file SRT mới (" + srtFile.name + ") vào Project. (Bạn có thể kéo file vào Timeline để tạo phụ đề).",
                    inserted: false
                });
            }
        }

        // -------------------------------------------------------------
        // CHẾ ĐỘ 2: CHÈN GRAPHIC TEXT TRACK (FULL FONT/SIZE/STROKE QUA FCP XML)
        // -------------------------------------------------------------
        if (mode === 'xml_graphic_track') {
            var xmlFile = new File(xmlPath);
            if (!xmlFile.exists) {
                // Fallback về SRT thông thường
                return importAndInsertToTimeline(srtPath, "", "caption_track", styleJsonStr, runTimestamp, timelineStartOffset);
            }

            // 1. Import file XML mới (có gắn timestamp) vào Project
            var importXmlSuccess = app.project.importFiles([xmlPath], true, targetBin, false);
            if (!importXmlSuccess) {
                return importAndInsertToTimeline(srtPath, "", "caption_track", styleJsonStr, runTimestamp, timelineStartOffset);
            }

            // 2. Tìm đúng Sequence phụ đề mới nhất được tạo từ XML theo runTimestamp (duyệt ngược từ cuối về đầu)
            var subSequenceItem = null;
            var subSequenceObj = null;

            if (app.project.sequences && app.project.sequences.numSequences > 0) {
                for (var s = app.project.sequences.numSequences - 1; s >= 0; s--) {
                    var seq = app.project.sequences[s];
                    if (seq && seq.name === expectedGraphicSeqName) {
                        subSequenceObj = seq;
                        if (seq.projectItem) {
                            subSequenceItem = seq.projectItem;
                        }
                        break;
                    }
                }
                // Fallback nếu Premiere đổi tên nhẹ: lấy sequence mới nhất có chứa expectedGraphicSeqName
                if (!subSequenceItem) {
                    for (var s2 = app.project.sequences.numSequences - 1; s2 >= 0; s2--) {
                        var seq2 = app.project.sequences[s2];
                        if (seq2 && seq2.name.indexOf(expectedGraphicSeqName) !== -1) {
                            subSequenceObj = seq2;
                            if (seq2.projectItem) {
                                subSequenceItem = seq2.projectItem;
                            }
                            break;
                        }
                    }
                }
            }

            if (!subSequenceItem) {
                subSequenceItem = findItemInProject(app.project.rootItem, "", expectedGraphicSeqName);
            }

            // 3. Đẩy Sequence phụ đề lên Track Video trên cùng của Active Sequence đúng tại vị trí timelineStartOffset
            var insertedToTimeline = false;
            if (activeSeq && subSequenceItem && activeSeq.videoTracks) {
                var numVideoTracks = activeSeq.videoTracks.numTracks;
                var targetVideoTrack = activeSeq.videoTracks[numVideoTracks - 1]; // Track trên cùng

                if (targetVideoTrack && targetVideoTrack.overwriteClip) {
                    try {
                        var insertTime = new Time();
                        insertTime.seconds = timelineStartOffset;
                        targetVideoTrack.overwriteClip(subSequenceItem, insertTime);
                        insertedToTimeline = true;
                    } catch (insertErr) {
                        // ignore
                    }
                }
            }

            // Đồng thời import kèm file SRT mới để người dùng có cả bản phụ đề gốc
            if (srtPath && new File(srtPath).exists) {
                app.project.importFiles([srtPath], true, targetBin, false);
            }

            if (insertedToTimeline) {
                return JSON.stringify({
                    success: true,
                    mode: 'xml_graphic_track',
                    message: "Đã tự động chèn Graphic Text Track mới (" + expectedGraphicSeqName + ") lên Timeline tại " + timelineStartOffset.toFixed(2) + "s!",
                    inserted: true
                });
            } else {
                return JSON.stringify({
                    success: true,
                    mode: 'xml_graphic_track',
                    message: "Đã tạo Sequence Phụ đề đồ họa mới (" + expectedGraphicSeqName + ") trong Project. Bạn có thể kéo thả vào Timeline!",
                    inserted: false
                });
            }
        }

        return JSON.stringify({
            success: true,
            message: "Đã xử lý xong phụ đề."
        });

    } catch (e) {
        return JSON.stringify({
            success: false,
            error: "Lỗi ExtendScript importAndInsertToTimeline: " + e.toString() + " (Line: " + e.line + ")"
        });
    }
}
