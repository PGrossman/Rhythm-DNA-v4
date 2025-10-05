# RhythmDNA v1.1.0 Release Notes
**Release Date:** October 4, 2025

## 🎉 Major Features Added

### 1. **Clickable File Names in Analysis Queue**
- **Feature:** Click any file name in the "Files to Process" table to open it in Finder
- **Implementation:** Uses existing `searchShowFile` IPC handler with hover effects
- **Location:** `app/renderer.js` lines 1451-1485
- **User Experience:** Blue underlined links with hover effects for better navigation

### 2. **LLM Fallback Detection for Instrumentation Failures**
- **Feature:** Shows "LLM DERIVED" (orange badge) when ensemble fails but LLM succeeds
- **Problem Solved:** Previously showed "ERROR" (red) even when LLM provided instruments
- **Implementation:** `app/renderer.js` lines 1437-1441 (fallback logic) + 1555-1556 (data copying)
- **User Experience:** Clear visual distinction between complete failure vs. LLM fallback success

### 3. **Enhanced Progress Counter**
- **Feature:** Shows "X of Y files processed" with breakdown of new vs. existing files
- **Implementation:** `app/renderer.js` lines 1401-1406
- **User Experience:** Better visibility into processing progress and file status

### 4. **AIFF Audio Format Support**
- **Feature:** Full support for `.aif` and `.aiff` audio files
- **Implementation:** Updated file scanning in `app/main.js` lines 90 & 246
- **UI Update:** Drop zone subtitle now mentions AIFF support
- **User Experience:** Seamless processing of professional audio formats

## 🔧 Technical Improvements

### **Model Path Fixes**
- **Fixed:** ML model paths in packaged Electron apps
- **Files:** `app/analysis/probes/clap-probe.js` & `mediapipe-yamnet.js`
- **Solution:** Use `app.getAppPath()` for packaged mode instead of `process.cwd()`
- **Result:** Models load correctly in DMG builds

### **Database Merge Improvements**
- **Enhanced:** Instrument priority system in `app/db/jsondb.js`
- **Priority Order:** `analysis.finalInstruments` > `analysis.instruments` > LLM suggestions
- **Result:** More accurate instrument detection in search results

### **Search Filter Fixes**
- **Fixed:** "Strings" filter not working due to section tag deletion
- **File:** `app/renderer/instrument_access.js`
- **Solution:** Preserve existing "(section)" tags from database
- **Result:** Proper filtering of orchestral sections

## 🐛 Bug Fixes

### **Instrumentation Error Handling**
- **Fixed:** Race condition in LLM fallback detection
- **Root Cause:** Track objects didn't contain creative analysis data
- **Solution:** Copy `data.analysis` and `data.creative` into track objects
- **Result:** LLM fallback status displays correctly

### **File Processing Pipeline**
- **Fixed:** "Update Database" button only calling `getSummary()`
- **Solution:** Properly trigger database update in `app/main.js`
- **Result:** Database updates correctly after processing

## 📊 Performance & Reliability

### **Error Recovery**
- **Improved:** Better handling of ensemble analysis failures
- **Fallback:** LLM analysis provides instrument detection when ensemble fails
- **Result:** Higher success rate for challenging audio files

### **UI Responsiveness**
- **Enhanced:** Real-time progress updates during processing
- **Added:** Visual feedback for different processing states
- **Result:** Better user experience during long processing sessions

## 🧪 Testing & Quality Assurance

### **Test File Collection**
- **Created:** Collection of 55 problematic files that failed ensemble analysis
- **Location:** `/test` folder for regression testing
- **Purpose:** Validate LLM fallback functionality

### **Comprehensive Logging**
- **Enhanced:** Better error tracking and debugging information
- **Added:** Debug logging for instrumentation status changes
- **Result:** Easier troubleshooting and issue resolution

## 🔄 Version History

### **From v1.0.0 to v1.1.0:**
- ✅ Clickable file names in analysis queue
- ✅ LLM fallback detection with orange "LLM DERIVED" status
- ✅ Enhanced progress counter with file breakdown
- ✅ AIFF audio format support (.aif, .aiff)
- ✅ Fixed model paths in packaged apps
- ✅ Improved database merge priority system
- ✅ Fixed "Strings" search filter
- ✅ Better error handling and recovery

## 🎯 User Impact

### **Improved Workflow**
- **Navigation:** Click files to locate them quickly
- **Status Clarity:** Know when LLM provided fallback instruments
- **Progress Visibility:** See exactly how many files are processed
- **Format Support:** Process professional AIFF audio files

### **Better Reliability**
- **Error Recovery:** LLM provides instruments when ensemble fails
- **Accurate Filtering:** Search filters work correctly for all instrument types
- **Stable Processing:** Model loading works in all deployment scenarios

## 📁 Files Modified

### **Core Application Files:**
- `app/renderer.js` - UI improvements and LLM fallback logic
- `app/main.js` - AIFF support and database update fixes
- `app/db/jsondb.js` - Enhanced instrument merge priority
- `app/renderer/instrument_access.js` - Fixed section tag handling

### **Model Integration:**
- `app/analysis/probes/clap-probe.js` - Fixed model paths
- `app/analysis/probes/mediapipe-yamnet.js` - Fixed model paths

### **Configuration:**
- `package.json` - Version bump to 1.1.0
- `forge.config.js` - Version bump to 1.1.0

## 🚀 Deployment

### **Build Information:**
- **Version:** 1.1.0
- **Build Date:** October 4, 2025
- **Archive:** `RhythmDNA_v1.1.0_20251004.zip`
- **Size:** ~50MB (excluding models and logs)

### **Compatibility:**
- **macOS:** 10.15+ (Catalina and later)
- **Architecture:** ARM64 (Apple Silicon)
- **Audio Formats:** MP3, WAV, AIFF (.aif, .aiff)
- **Dependencies:** Node.js 22.14.0, Electron Forge

---

**RhythmDNA v1.1.0** represents a significant improvement in user experience, reliability, and feature completeness. The LLM fallback system ensures better instrument detection success rates, while the enhanced UI provides clearer feedback and easier navigation.

*For technical support or feature requests, please refer to the project documentation.*

