const fs = require('fs');
let content = fs.readFileSync('UploadScreen.tsx', 'utf8');

const targetFunction = `  async function pickFile() {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        toast.show('Permission required: media library access is needed');
        return;
      }

      // 🚨 THE FIX: Use MediaTypeOptions.All to force Google Photos Gallery, 
      // but keep multi-selection active!
      const imgRes = await ImagePicker.launchImageLibraryAsync({ 
        mediaTypes: ImagePicker.MediaTypeOptions.All, 
        allowsMultipleSelection: true,
        selectionLimit: 5,
        quality: 1,
      });

      if (!imgRes.canceled && imgRes.assets && imgRes.assets.length > 0) {
        // 🔍 FILTER ENGINE: Loop through and discard any accidently selected photos
        const onlyVideos = imgRes.assets.filter(asset => 
          asset.type === 'video' || (asset.mimeType && asset.mimeType.startsWith('video/'))
        );

        if (onlyVideos.length === 0) {
          toast.show('Please select videos only!');
          return;
        }

        setFilesList(onlyVideos); 
        setCurrentVideoIndex(0);     
        return;
      }
    } catch (e: any) {
      console.log('PICK FILE ERROR', e);
      toast.show('File pick error: ' + (e?.message || String(e)));
    }
  }`;

// Replace the old function block
content = content.replace(/async function pickFile\(\)[\s\S]*?\n  \}/, targetFunction);
fs.writeFileSync('UploadScreen.tsx', content, 'utf8');
console.log('✅ UploadScreen patched successfully!');
