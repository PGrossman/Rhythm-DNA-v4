// DragDrop module - handles file/folder drop events
// Returns absolute paths using webkitGetAsEntry API

export class DragDrop {
    constructor() {
        console.log('[DragDrop] Module initialized');
        this.dropZone = null;
    }
    
    setupDropZone(element) {
        if (!element) {
            console.error('[DragDrop] No element provided');
            return;
        }
        
        this.dropZone = element;
        
        // Prevent default drag behaviors
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            this.dropZone.addEventListener(eventName, this.preventDefaults, false);
            document.body.addEventListener(eventName, this.preventDefaults, false);
        });
        
        // Highlight
        ['dragenter', 'dragover'].forEach(eventName => {
            this.dropZone.addEventListener(eventName, () => {
                this.dropZone.classList.add('drag-over');
            }, false);
        });
        ['dragleave', 'drop'].forEach(eventName => {
            this.dropZone.addEventListener(eventName, () => {
                this.dropZone.classList.remove('drag-over');
            }, false);
        });
        
        // Handle drop
        this.dropZone.addEventListener('drop', async (e) => {
            await this.handleDrop(e);
        }, false);
    }
    
    preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }
    
    async handleDrop(e) {
        const items = e.dataTransfer.items;
        const paths = [];
        console.log('[DragDrop] Processing', items?.length || 0, 'dropped items');
        if (!items) return;
        // Get real filesystem paths from File objects
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === 'file') {
                const file = item.getAsFile?.();
                if (file && file.path) {
                    paths.push(file.path);
                    console.log('[DragDrop] Added file:', file.path);
                }
            }
        }
        console.log('[DragDrop] Total paths collected:', paths.length);
        if (paths.length > 0) {
            const result = await window.api.scanDropped(paths);
            const tracks = result?.tracks || [];
            console.log('[DragDrop] Main returned:', tracks.length, 'tracks');
            this.dropZone.dispatchEvent(new CustomEvent('filesDropped', { detail: { tracks } }));
        }
    }
    
    // Directory scanning removed for now. Add recursive handling if needed.
}


