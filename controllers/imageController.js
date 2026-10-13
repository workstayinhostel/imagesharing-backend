const supabase = require('../config/supabase');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const r2Service = require('../services/r2Service');

exports.preview = asyncHandler(async (req, res) => {
  const { data: file, error } = await supabase
    .from('room_files')
    .select('file_key, file_name, file_type, category')
    .eq('id', req.params.fileId)
    .eq('room_code', req.room.roomCode)
    .maybeSingle();
  if (error) throw error;
  if (!file) throw new AppError(404, 'FILE_NOT_FOUND', 'File not found.');
  if (file.category !== 'image') throw new AppError(415, 'NOT_AN_IMAGE', 'This file is not an image.');
  res.set('Cache-Control', 'private, no-store').json({
    url: await r2Service.presignPreview(file.file_key),
    fileName: file.file_name,
    fileType: file.file_type,
  });
});
