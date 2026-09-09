Pod::Spec.new do |s|
  s.name = 'StenografRoomplan'
  s.version = '0.1.0'
  s.summary = 'Apple RoomPlan bridge for Stenograf (LiDAR room measurement and stage walkthrough)'
  s.license = 'MIT'
  s.homepage = 'https://github.com/vvana/stenograf'
  s.author = 'vvana'
  s.source = { :git => 'https://github.com/vvana/stenograf.git', :tag => s.version.to_s }
  s.source_files = 'ios/Plugin/**/*.{swift,h,m}'
  s.ios.deployment_target = '17.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.1'
  s.frameworks = 'RoomPlan', 'ARKit', 'CoreImage'
end
